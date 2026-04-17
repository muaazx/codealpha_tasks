// Stream route – tries the user's selected provider first, falls back intelligently.

// ── Helper: stream via Google Generative AI (Gemini) ──────────────────────────
async function streamWithGoogleAI(
  messages: { role: string; content: string }[],
  systemPrompt: string | undefined,
  temperature: number
): Promise<Response | null> {
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!googleKey) return null;

  console.log("Trying Google Generative AI (Gemini) – direct path...");

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

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:streamGenerateContent?alt=sse&key=${googleKey}`;

  const geminiResponse = await fetch(geminiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  if (!geminiResponse.ok) {
    const errText = await geminiResponse.text();
    console.warn(`Google AI error (${geminiResponse.status}):`, errText.slice(0, 200));
    return null; // Return null so caller can try fallback
  }

  // Pipe Gemini SSE → our SSE format
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const reader = geminiResponse.body?.getReader();
      if (!reader) { controller.close(); return; }

      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += new TextDecoder().decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "data: [DONE]") continue;
            if (trimmed.startsWith("data: ")) {
              try {
                const dataJSON = JSON.parse(trimmed.slice(6));
                const text = dataJSON.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: text })}\n\n`));
                }
              } catch (_) { /* partial JSON */ }
            }
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err: any) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: `\n\n[Stream Error: ${err.message}]` })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

// ── Helper: stream via OpenRouter ─────────────────────────────────────────────
async function streamWithOpenRouter(
  messages: { role: string; content: string }[],
  systemPrompt: string | undefined,
  temperature: number,
  model: string
): Promise<Response | null> {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) return null;

  console.log(`OpenRouter stream: model=${model}, messages=${messages?.length}`);

  const openRouterMessages = [...messages];
  if (systemPrompt?.trim()) {
    openRouterMessages.unshift({ role: "system", content: systemPrompt.trim() });
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 30000);

  let response: globalThis.Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
        stream: true,
      }),
      signal: abortController.signal,
    });
    clearTimeout(timeout);
  } catch (err: any) {
    clearTimeout(timeout);
    console.warn(`OpenRouter request failed/timed out: ${err.message}`);
    return null;
  }

  if (!response.ok) {
    console.warn(`OpenRouter model ${model} failed (${response.status})`);
    return null;
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const reader = response.body?.getReader();
      if (!reader) { controller.close(); return; }

      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += new TextDecoder().decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "data: [DONE]") continue;
            if (trimmed.startsWith("data: ")) {
              try {
                const dataJSON = JSON.parse(trimmed.slice(6));
                const content = dataJSON.choices?.[0]?.delta?.content;
                if (content) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`));
                }
              } catch (_) { /* partial JSON */ }
            }
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error: any) {
        console.error("OpenRouter streaming error:", error);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: `\n\n[Stream Error: ${error.message}]` })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

// ── Helper: return an SSE error message ───────────────────────────────────────
function sseError(message: string): Response {
  return new Response(
    `data: ${JSON.stringify({ content: message })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

// ── Main POST handler ─────────────────────────────────────────────────────────
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { messages, model: requestedModel, temperature, customSystemPrompt } = body;

    const temp = temperature ?? 0.7;
    const isGeminiDirect = !requestedModel || requestedModel === "google-gemini";

    if (isGeminiDirect) {
      // ── User wants Gemini Direct: try Google API first, fall back to OpenRouter ──
      const googleResponse = await streamWithGoogleAI(messages, customSystemPrompt, temp);
      if (googleResponse) return googleResponse;

      console.warn("Google AI unavailable, falling back to OpenRouter free...");
      const orFallback = await streamWithOpenRouter(messages, customSystemPrompt, temp, "openrouter/free");
      if (orFallback) return orFallback;

      return sseError("Both Google AI and OpenRouter are unavailable. Please try again in a minute.");
    }

    // ── User picked an OpenRouter model: go straight to OpenRouter ─────────
    const orResponse = await streamWithOpenRouter(messages, customSystemPrompt, temp, requestedModel);
    if (orResponse) return orResponse;

    // That specific model failed — try openrouter/free as fallback
    console.warn(`Model ${requestedModel} failed, trying openrouter/free...`);
    const orFree = await streamWithOpenRouter(messages, customSystemPrompt, temp, "openrouter/free");
    if (orFree) return orFree;

    // Last resort: try Google AI
    const googleFallback = await streamWithGoogleAI(messages, customSystemPrompt, temp);
    if (googleFallback) return googleFallback;

    return sseError("All providers are unavailable. Please try again later.");

  } catch (error: any) {
    console.error("API Route Error:", error);
    return new Response(
      `data: ${JSON.stringify({ content: "Unexpected error. Please refresh and try again." })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } }
    );
  }
}