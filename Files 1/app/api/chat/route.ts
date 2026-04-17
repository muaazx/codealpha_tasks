import { NextResponse } from "next/server";

// Helper: call Google Generative AI (Gemini) non-streaming as fallback
async function callGoogleAI(
  messages: { role: string; content: string }[],
  systemPrompt: string | undefined,
  temperature: number
): Promise<NextResponse> {
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!googleKey) {
    return NextResponse.json({
      choices: [{ message: { role: "assistant", content: "Both OpenRouter and Google AI keys are missing. Please configure at least one API key." } }]
    }, { status: 500 });
  }

  console.log("Falling back to Google Generative AI (Gemini)...");

  const contents = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const requestBody: any = {
    contents,
    generationConfig: { temperature },
  };

  if (systemPrompt?.trim()) {
    requestBody.systemInstruction = { parts: [{ text: systemPrompt.trim() }] };
  }

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${googleKey}`;

  const geminiResponse = await fetch(geminiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  if (!geminiResponse.ok) {
    const errText = await geminiResponse.text();
    console.error("Google AI error:", errText);
    return NextResponse.json({
      choices: [{ message: { role: "assistant", content: `AI unavailable (Google Error: ${geminiResponse.status}). Please try again later.` } }]
    }, { status: 200 });
  }

  const data = await geminiResponse.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  return NextResponse.json({
    choices: [{ message: { role: "assistant", content: text || "Empty response from Google AI." } }]
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { messages, model: requestedModel, temperature, customSystemPrompt } = body;

    const openRouterKey = process.env.OPENROUTER_API_KEY;

    // ── No OpenRouter key → go straight to Google AI ──────────────────────
    if (!openRouterKey) {
      console.warn("OPENROUTER_API_KEY not set. Using Google Generative AI fallback.");
      return callGoogleAI(messages, customSystemPrompt, temperature ?? 0.7);
    }

    const model = requestedModel || "google/gemini-2.0-flash-exp:free";
    console.log(`OpenRouter non-streaming request: model=${model}, messages=${messages?.length}`);

    const openRouterMessages = [...messages];
    if (customSystemPrompt?.trim()) {
      openRouterMessages.unshift({ role: "system", content: customSystemPrompt.trim() });
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openRouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
        "X-Title": "Knowledge AI",
      },
      body: JSON.stringify({
        model,
        messages: openRouterMessages,
        temperature: temperature ?? 0.7,
        stream: false,
      }),
    });

    // ── OpenRouter failed → fall back to Google AI ────────────────────────
    if (!response.ok) {
      console.warn(`OpenRouter failed with ${response.status}. Falling back to Google AI...`);
      return callGoogleAI(messages, customSystemPrompt, temperature ?? 0.7);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      return NextResponse.json({
        choices: [{ message: { role: "assistant", content: "Empty response from OpenRouter." } }]
      });
    }

    return NextResponse.json({
      choices: [{ message: { role: "assistant", content } }]
    });

  } catch (error: any) {
    console.error("API Route Error:", error);
    return NextResponse.json({
      choices: [{ message: { role: "assistant", content: `Service Error: ${error.message}` } }]
    }, { status: 200 });
  }
}