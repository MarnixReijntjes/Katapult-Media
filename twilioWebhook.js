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

app.post("/voice", (req, res) => {
  const systemPrompt = buildSystemPrompt("des");
  console.log("Incoming call To:", req.body.To, "From:", req.body.From);
  console.log("SYSTEM PROMPT LOADED\n", systemPrompt);

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
      Goedemiddag, u spreekt met Tessa van Dutch Empire Security. Waar kan ik u mee helpen?
    </Say>
  </Gather>

  <Say language="nl-NL" voice="Polly.Lotte">
    Ik heb helaas niets gehoord. Kunt u het nog een keer zeggen?
  </Say>

  <Redirect method="POST">/voice</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

app.post("/handle-speech", async (req, res) => {
  try {
    const speech = (req.body.SpeechResult || "").trim();
    console.log("USER SAID:", speech);

    if (!speech) {
      const twimlEmpty = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="nl-NL" voice="Polly.Lotte">
    Sorry, dat kwam niet goed door. Kunt u het kort herhalen?
  </Say>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
      return res.type("text/xml").send(twimlEmpty);
    }

    const systemPrompt = buildSystemPrompt("des");
    const reply = await generateReply({ systemPrompt, userText: speech });

    const safeReply = escapeForTwiml(reply);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="nl-NL" voice="Polly.Lotte">${safeReply}</Say>
  <Gather
    input="speech"
    language="nl-NL"
    action="/handle-speech"
    method="POST"
    timeout="3"
    speechTimeout="auto"
    actionOnEmptyResult="true">
    <Say language="nl-NL" voice="Polly.Lotte">
      Kan ik nog iets noteren voor het terugbelverzoek?
    </Say>
  </Gather>
  <Say language="nl-NL" voice="Polly.Lotte">
    Dank u wel. Een medewerker neemt contact met u op.
  </Say>
</Response>`;

    return res.type("text/xml").send(twiml);
  } catch (err) {
    console.error("handle-speech error:", err?.message || err);
    const twimlFail = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="nl-NL" voice="Polly.Lotte">
    Sorry, er ging iets mis. Ik noteer dit als terugbelverzoek. Een medewerker neemt contact met u op.
  </Say>
</Response>`;
    return res.type("text/xml").send(twimlFail);
  }
});

module.exports = { app };
