const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config({ path: '.env.local' });
const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
async function run() {
  const models = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`).then(r => r.json());
  console.log(models);
}
run();
