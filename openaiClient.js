async function generateReply({ systemPrompt, userText }) {
  const client = getOpenAIClient();

  const resp = await client.responses.create({
    model: "gpt-5-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText }
    ],
    max_output_tokens: 120
  });

  const text = (resp.output_text || "").trim();
  return text; // Als er geen tekst is, komt er ook geen fallback.
}
