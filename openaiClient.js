const OpenAI = require("openai");

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY ontbreekt");
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

async function generateReply({ systemPrompt, userText }) {
  const client = getOpenAIClient();

  const resp = await client.responses.create({
    model: "gpt-5-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText }
    ],
    max_output_tokens: 150
  });

  // VEILIG uitlezen van response
  if (!resp.output || !resp.output.length) {
    throw new Error("OpenAI response leeg");
  }

  const texts = [];
  for (const item of resp.output) {
    if (item.content) {
      for (const c of item.content) {
        if (c.type === "output_text" && c.text) {
          texts.push(c.text);
        }
      }
    }
  }

  const finalText = texts.join(" ").trim();
  if (!finalText) {
    throw new Error("Geen tekst in OpenAI output");
  }

  return finalText;
}

module.exports = { generateReply };
