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

app.post("/handle-speech", (req, res) => {
  const speech = req.body.SpeechResult;
  console.log("User said:", speech);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="nl-NL" voice="Polly.Lotte">
    Dank u. Ik ga dit doorgeven aan een medewerker.
  </Say>
</Response>`;

  res.type("text/xml").send(twiml);
});
