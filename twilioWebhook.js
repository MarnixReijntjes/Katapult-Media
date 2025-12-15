const express = require("express");
const { buildSystemPrompt } = require("./promptBuilder");

const app = express();
app.use(express.urlencoded({ extended: false }));

app.post("/voice", (req, res) => {
  const systemPrompt = buildSystemPrompt("des");
  console.log("Incoming call To:", req.body.To, "From:", req.body.From);
  console.log("SYSTEM PROMPT LOADED\n", systemPrompt);

  // Snellere speech capture:
  // - timeout: hoe lang wachten tot je begint te praten
  // - speechTimeout: wanneer Twilio stopt met luisteren na stilte ("auto" is sneller/strakker)
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

app.post("/handle-speech", (req, res) => {
  const speech = (req.body.SpeechResult || "").trim();
  console.log("USER SAID:", speech);

  // Als Twilio niets herkent: meteen opnieuw vragen, geen dode eindes.
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

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="nl-NL" voice="Polly.Lotte">
    Dank u. Ik noteer dit als terugbelverzoek. Mag ik uw naam en telefoonnummer?
  </Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

module.exports = { app };
