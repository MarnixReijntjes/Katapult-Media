// companies/des/server.js
import dotenv from "dotenv";
import http from "http";

dotenv.config();

const PORT = process.env.PORT || 10000;

const INBOUND_GREETING = process.env.INBOUND_GREETING || "Hoi, met Tessa van DES.";

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";

function sendXml(res, xml) {
  res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
  res.end(xml);
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// Super simpele in-memory cache: voldoende voor 1 vaste greeting
let cachedMp3 = null;
let cachedText = null;
let cachedAt = 0;

async function synthesizeElevenMp3(text) {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
    throw new Error("ELEVEN_NOT_CONFIGURED");
  }

  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      model_id: ELEVEN_MODEL,
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`ELEVEN_TTS_FAILED ${resp.status}: ${err}`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error("ELEVEN_EMPTY_AUDIO");
  return buf;
}

const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (path === "/health" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        service: "des-inbound-eleven-play",
        timestamp: new Date().toISOString(),
        eleven_configured: !!(ELEVEN_API_KEY && ELEVEN_VOICE_ID),
        cached: !!cachedMp3,
      });
    }

    // Twilio calls this (Voice webhook)
    if (path === "/twiml" && req.method === "POST") {
      console.log(`[${new Date().toISOString()}] TwiML hit method=POST url=/twiml`);

      // Als Eleven niet geconfigureerd is -> fallback Say (zodat je nooit "application error" krijgt)
      if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="nl-NL">Hoi, met Tessa van DES.</Say>
</Response>`;
        return sendXml(res, twiml);
      }

      const baseUrl = `https://${req.headers.host}`;
      // ts om caching issues te vermijden
      const audioUrl = `${baseUrl}/audio.mp3?ts=${Date.now()}`;

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${escapeXml(audioUrl)}</Play>
</Response>`;

      console.log(`[${new Date().toISOString()}] TwiML served <Play> url=${audioUrl}`);
      return sendXml(res, twiml);
    }

    // Twilio fetches this MP3
    if (path === "/audio.mp3" && req.method === "GET") {
      // 1 uur cache op exacte tekst
      const now = Date.now();
      const cacheValid =
        cachedMp3 && cachedText === INBOUND_GREETING && now - cachedAt < 60 * 60 * 1000;

      if (!cacheValid) {
        const t0 = Date.now();
        try {
          cachedMp3 = await synthesizeElevenMp3(INBOUND_GREETING);
          cachedText = INBOUND_GREETING;
          cachedAt = Date.now();
          console.log(
            `[${new Date().toISOString()}] ✅ Eleven generated greeting bytes=${cachedMp3.length} ms=${
              Date.now() - t0
            }`
          );
        } catch (e) {
          console.error(`[${new Date().toISOString()}] ❌ Eleven failed: ${e.message}`);
          // Als mp3 genereren faalt -> serveer 500 zodat we het in logs zien (Twilio kan dan nog steeds falen)
          return sendJson(res, 500, { error: e.message });
        }
      } else {
        console.log(`[${new Date().toISOString()}] ♻️ Using cached greeting mp3`);
      }

      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      });
      res.end(cachedMp3);
      return;
    }

    return sendJson(res, 404, { error: "Not Found" });
  } catch (e) {
    console.error("HTTP error:", e);
    return sendJson(res, 500, { error: "Internal Server Error" });
  }
});

httpServer.listen(PORT, () => {
  console.log(`✅ DES inbound Eleven <Play> live on ${PORT}`);
});

function escapeXml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
