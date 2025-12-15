const { app } = require("./twilioWebhook");

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on", PORT));
