const OpenAI = require("openai");

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY env var");
  return new OpenAI({ apiKey });
}

async function generateReply({ systemPrompt, userText }) {
  const client = getOpenAIClient();

  // Responses API (aanbevolen in OpenAI docs)
  const resp = await client.responses.create({
    model: "gpt-5-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText }
    ],
    // Hou het kort voor voice
    max_output_tokens: 120
  });

  // SDK geeft doorgaans resp.output_text; fallback op parsing als het ontbreekt
  const text = (resp.output_text || "").trim();
  return text || "Dank u. Ik noteer dit als terugbelverzoek. Mag ik uw naam en telefoonnummer?";
}

module.exports = { generateReply };
