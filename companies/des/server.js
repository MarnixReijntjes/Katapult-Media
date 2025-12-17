// companies/des/server.js
import dotenv from "dotenv";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

dotenv.config();

const PORT = process.env.PORT || 10000;

const INBOUND_GREETING = process.env.INBOUND_GREETING || "Hoi, met Tessa van DES.";

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY missing");
  process.exit(1);
}
if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
  console.error("❌ ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID missing");
  process.exit(1);
}

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

/* =========================
   ElevenLabs greeting cache (mp3 for <Play>)
========================= */
let cachedMp3 = null;
let cachedText = null;
let cachedAt = 0;

async function synthesizeElevenMp3(text) {
  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
    {
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
    }
  );

  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`ELEVEN_TTS_FAILED ${resp.status}: ${err}`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error("ELEVEN_EMPTY_AUDIO");
  return buf;
}

/* =========================
   HTTP (TwiML + audio)
========================= */
const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (path === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "des-inbound-eleven-greeting-openai-stt-only",
        ts: new Date().toISOString(),
      });
    }

    if (path === "/twiml" && req.method === "POST") {
      console.log(`[${new Date().toISOString()}] TwiML hit`);

      const now = Date.now();
      const cacheValid =
        cachedMp3 &&
        cachedText === INBOUND_GREETING &&
        now - cachedAt < 60 * 60 * 1000;

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
      const wsUrl = `wss://${req.headers.host}/ws`;

      // Play greeting -> then connect stream
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${escapeXml(audioUrl)}</Play>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" />
  </Connect>
</Response>`;

      console.log(
        `[${new Date().toISOString()}] TwiML served <Play> + <Stream> ws=${wsUrl}`
      );
      return sendXml(res, twiml);
    }

    if (path === "/audio.mp3" && req.method === "GET") {
      if (!cachedMp3) return sendJson(res, 404, { error: "No audio cached" });
      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      });
      return res.end(cachedMp3);
    }

    return sendJson(res, 404, { error: "Not Found" });
  } catch (e) {
    console.error("HTTP error:", e);
    return sendJson(res, 500, { error: "Internal Server Error" });
  }
});

/* =========================
   WebSockets: Twilio -> OpenAI STT only
========================= */
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (twilioWs, req) => {
  if (req.url !== "/ws") {
    twilioWs.close();
    return;
  }

  let streamSid = null;
  console.log(`[${new Date().toISOString()}] WS connected url=${req.url}`);

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  function safeOpenAI(obj) {
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(JSON.stringify(obj));
  }

  openaiWs.on("open", () => {
    // Key change: create_response = false (STT only, no assistant responses)
    safeOpenAI({
      type: "session.update",
      session: {
        modalities: ["text"],
        input_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: false,
        },
      },
    });
    console.log(`[${new Date().toISOString()}] OpenAI STT-only session ready`);
  });

  twilioWs.on("message", (buf) => {
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
      safeOpenAI({ type: "input_audio_buffer.append", audio: msg.media.payload });
      return;
    }

    if (msg.event === "stop") {
      console.log(`[${new Date().toISOString()}] Twilio stop streamSid=${streamSid}`);
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
      return;
    }
  });

  openaiWs.on("message", (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }

    if (evt.type === "input_audio_buffer.speech_started") {
      console.log(`[${new Date().toISOString()}] 🎙️ speech_started`);
      return;
    }
    if (evt.type === "input_audio_buffer.speech_stopped") {
      console.log(`[${new Date().toISOString()}] 🎙️ speech_stopped`);
      return;
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      console.log(`[${new Date().toISOString()}] 📝 USER SAID: "${evt.transcript}"`);
      return;
    }

    if (evt.type === "error") {
      console.error(`[${new Date().toISOString()}] ❌ OpenAI error:`, JSON.stringify(evt.error));
    }
  });

  openaiWs.on("close", (code) => {
    console.log(`[${new Date().toISOString()}] OpenAI WS closed code=${code}`);
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  openaiWs.on("error", (e) => {
    console.error(`[${new Date().toISOString()}] OpenAI WS error:`, e.message);
  });

  twilioWs.on("close", () => {
    console.log(`[${new Date().toISOString()}] Twilio WS closed streamSid=${streamSid}`);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  twilioWs.on("error", (e) => {
    console.error(`[${new Date().toISOString()}] Twilio WS error:`, e.message);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
});

httpServer.listen(PORT, () => {
  console.log(`✅ DES inbound (Eleven greeting) + OpenAI STT-only live on ${PORT}`);
});
