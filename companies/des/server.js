import dotenv from "dotenv";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

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
function escapeXml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// --- greeting mp3 cache ---
let cachedMp3 = null;
let cachedText = null;
let cachedAt = 0;

async function synthesizeElevenMp3(text) {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) throw new Error("ELEVEN_NOT_CONFIGURED");

  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg"
    },
    body: JSON.stringify({
      model_id: ELEVEN_MODEL,
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.8 }
    })
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
        service: "des-inbound-eleven-play-stream-baseline",
        ts: new Date().toISOString(),
        eleven_configured: !!(ELEVEN_API_KEY && ELEVEN_VOICE_ID)
      });
    }

    // Twilio Voice webhook
    if (path === "/twiml" && req.method === "POST") {
      console.log(`[${new Date().toISOString()}] TwiML hit method=POST url=/twiml`);

      // Fallback als Eleven mist
      if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="nl-NL">Hoi, met Tessa van DES.</Say>
</Response>`;
        return sendXml(res, twiml);
      }

      // Zorg dat audio.mp3 bestaat (cache 1 uur)
      const now = Date.now();
      const cacheValid =
        cachedMp3 && cachedText === INBOUND_GREETING && now - cachedAt < 60 * 60 * 1000;

      if (!cacheValid) {
        const t0 = Date.now();
        cachedMp3 = await synthesizeElevenMp3(INBOUND_GREETING);
        cachedText = INBOUND_GREETING;
        cachedAt = Date.now();
        console.log(
          `[${new Date().toISOString()}] ✅ Eleven greeting bytes=${cachedMp3.length} ms=${Date.now() - t0}`
        );
      } else {
        console.log(`[${new Date().toISOString()}] ♻️ Using cached greeting mp3`);
      }

      const baseUrl = `https://${req.headers.host}`;
      const audioUrl = `${baseUrl}/audio.mp3?ts=${Date.now()}`;

      // BELANGRIJK: Play greeting -> daarna Connect Stream
      const wsUrl = `wss://${req.headers.host}/ws`;

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${escapeXml(audioUrl)}</Play>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" />
  </Connect>
</Response>`;

      console.log(`[${new Date().toISOString()}] TwiML served <Play> + <Stream> ws=${wsUrl}`);
      return sendXml(res, twiml);
    }

    // Twilio fetches this MP3
    if (path === "/audio.mp3" && req.method === "GET") {
      if (!cachedMp3) return sendJson(res, 404, { error: "No audio cached" });

      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store"
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

// --- WebSocket: Twilio Media Streams baseline (alleen loggen) ---
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  if (req.url !== "/ws") {
    ws.close();
    return;
  }

  let streamSid = null;
  let mediaFrames = 0;
  let mediaBytesB64 = 0;

  console.log(`[${new Date().toISOString()}] WS connected url=${req.url}`);

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      console.log(
        `[${new Date().toISOString()}] Twilio start streamSid=${streamSid} callSid=${msg.start?.callSid}`
      );
      return;
    }

    if (msg.event === "media") {
      mediaFrames++;
      const p = msg.media?.payload || "";
      mediaBytesB64 += p.length;
      if (mediaFrames % 50 === 0) {
        console.log(
          `[${new Date().toISOString()}] Twilio media streamSid=${streamSid} frames=${mediaFrames} b64chars=${mediaBytesB64}`
        );
      }
      return;
    }

    if (msg.event === "stop") {
      console.log(
        `[${new Date().toISOString()}] Twilio stop streamSid=${streamSid} frames=${mediaFrames} b64chars=${mediaBytesB64}`
      );
      return;
    }
  });

  ws.on("close", () => {
    console.log(`[${new Date().toISOString()}] WS closed streamSid=${streamSid}`);
  });

  ws.on("error", (e) => {
    console.error(`[${new Date().toISOString()}] WS error:`, e.message);
  });
});

httpServer.listen(PORT, () => {
  console.log(`✅ DES inbound live on ${PORT}`);
});
