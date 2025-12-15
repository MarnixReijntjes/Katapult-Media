const express = require("express");
const { buildSystemPrompt } = require("./promptBuilder");
const { generateReply } = require("./openaiClient");

const app = express();
app.use(express.urlencoded({ extended: false }));

function escapeForTwiml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function listenAgainTwiml(sayText) {
  const safe = escapeForTwiml(sayText);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="nl-NL" voice="Polly.Lotte">${safe}</Say>
  <Gather
    input="speech"
    language="nl-NL"
    action="/handle-speech"
    method="POST"
    timeout="3"
    speechTimeout="auto"
    actionOnEmptyResult="true">
    <Say language="nl-NL" voice="Polly.Lotte">
      Kan ik u verder nog ergens mee helpen?
    </Say>
  </Gather>
</Response>`;
}

app.post("/voice", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather
    input="speech"
    language="nl-NL"
    action="/handle-speech"
    method="POST"
    timeout="3"
    speechTimeout="auto"
    actionOnEmptyResult="true">
    <Say language="nl-NL" voice="Polly.Lotte">
      Goedemiddag, u spreekt met Tessa, de digitale receptionist van Dutch Empire Security. Waar kan ik u mee helpen?
    </Say>
  </Gather>
</Response>`;

  res.type("text/xml").send(twiml);
});

app.post("/handle-speech", async (req, res) => {
  try {
    const userText = (req.body.SpeechResult || "").trim();
    console.log("USER SAID:", userText);

    if (!userText) {
      const retry = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="nl-NL" voice="Polly.Lotte">
    Sorry, dat verstond ik niet goed. Kunt u het nog een keer zeggen?
  </Say>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
      return res.type("text/xml").send(retry);
    }

    const systemPrompt = buildSystemPrompt("des");
    const reply = await generateReply({
      systemPrompt,
      userText
    });

    return res.type("text/xml").send(
      listenAgainTwiml(reply)
    );

  } catch (err) {
    console.error("ERROR:", err);
    const fail = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="nl-NL" voice="Polly.Lotte">
    Sorry, er ging iets mis. Kunt u het later nog eens proberen?
  </Say>
</Response>`;
    return res.type("text/xml").send(fail);
  }
});

module.exports = { app };
