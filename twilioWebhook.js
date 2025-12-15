const express = require("express");
const { buildSystemPrompt } = require("./promptBuilder");

const app = express();
app.use(express.urlencoded({ extended: false }));

app.post("/voice", (req, res) => {
  // Voor nu hardcoded DES (schaalbaar: later mapping op req.body.To)
  const systemPrompt = buildSystemPrompt("des");

  // Demo: spreek 1 zin uit + toon dat prompt geladen is (in logs)
  console.log("Incoming call To:", req.body.To, "From:", req.body.From);
  console.log(systemPrompt);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="nl-NL" voice="Polly.Lotte">
    Goedemiddag, u spreekt met Tessa, de digitale receptionist van Dutch Empire Security. Waar kan ik u mee helpen?
  </Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

module.exports = { app };
