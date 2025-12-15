const express = require("express");
const { buildSystemPrompt } = require("./promptBuilder");

const app = express();
app.use(express.urlencoded({ extended: false }));

app.post("/voice", (req, res) => {
  const systemPrompt = buildSystemPrompt("des");
  console.log("Incoming call To:", req.body.To, "From:", req.body.From);
  console.log(systemPrompt);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="nl-NL" timeout="5" action="/handle-speech" method="POST">
    <Say language="nl-NL" voice="Polly.Lotte">
      Goedemiddag, u spreekt met Tessa van Dutch Empire Security. Waar kan ik u mee helpen?
    </Say>
  </Gather>
  <Say language="nl-NL" voice="Polly.Lotte">
    Ik heb helaas niets gehoord. Kunt u het nog een keer proberen?
  </Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

app.post("/handle-speech", (req, res) => {
  const speech = req.body.SpeechResult || "";
  console.log("User said:", speech);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="nl-NL" voice="Polly.Lotte">
    Dank u. Ik noteer dit als terugbelverzoek. Mag ik uw naam en telefoonnummer?
  </Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

module.exports = { app };
