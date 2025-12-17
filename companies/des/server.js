// companies/des/server.js
import dotenv from "dotenv";
import http from "http";

dotenv.config();

const PORT = process.env.PORT || 10000;

// Render/Cloudflare -> Twilio kan via POST komen zonder querystring
function sendXml(res, xml) {
  res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
  res.end(xml);
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const httpServer = http.createServer(async (req, res) => {
  try {
    // simpele router
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    // Health
    if (path === "/health" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        service: "des-inbound-baseline",
        timestamp: new Date().toISOString(),
      });
    }

    // Twilio Voice webhook (inbound)
    // Zet in Twilio "A call comes in" -> Webhook -> https://<render>/twiml  (HTTP POST)
    if (path === "/twiml" && req.method === "POST") {
      console.log(`[${new Date().toISOString()}] TwiML hit method=POST url=/twiml`);

      // Baseline: geen Play, geen Eleven. Alleen Say.
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="nl-NL" voice="Polly.Lotte">Hoi, met Tessa van DES.</Say>
</Response>`;

      return sendXml(res, twiml);
    }

    // fallback
    return sendJson(res, 404, { error: "Not Found" });
  } catch (e) {
    console.error("HTTP error:", e);
    return sendJson(res, 500, { error: "Internal Server Error" });
  }
});

httpServer.listen(PORT, () => {
  console.log(`✅ DES inbound baseline live on ${PORT}`);
});
