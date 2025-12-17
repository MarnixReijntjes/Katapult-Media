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
   ElevenLabs greeting cache
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

  return Buffer.from(await resp.arrayBuffer());
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
        service: "des-inbound-eleven-stt",
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
      }

      const baseUrl = `https://${req.headers.host}`;
      const audioUrl = `${baseUrl}/audio.mp3?ts=${Date.now()}`;
      const wsUrl = `wss://${req.headers.host}/ws`;

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${escapeXml(audioUrl)}</Play>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" />
  </Connect>
</Response>`;

      return sendXml(res, twiml);
    }

    if (path === "/audio.mp3") {
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
   WebSockets
========================= */
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (twilioWs, req) => {
  if (req.url !== "/ws") {
    twilioWs.close();
    return;
  }

  let streamSid = null;

  console.log(`[${new Date().toISOString()}] WS connected`);

  // OpenAI Realtime (STT only)
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    openaiWs.send(
      JSON.stringify({
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
          },
        },
      })
    );
    console.log(`[${new Date().toISOString()}] OpenAI STT session ready`);
  });

  twilioWs.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid;
      console.log(
        `[${new Date().toISOString()}] Twilio start streamSid=${streamSid}`
      );
      return;
    }

    if (msg.event === "media") {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload,
          })
        );
      }
      return;
    }

    if (msg.event === "stop") {
      console.log(
        `[${new Date().toISOString()}] Twilio stop streamSid=${streamSid}`
      );
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    }
  });

  openaiWs.on("message", (raw) => {
    const evt = JSON.parse(raw);

    if (
      evt.type === "conversation.item.input_audio_transcription.completed"
    ) {
      console.log(
        `[${new Date().toISOString()}] 📝 USER SAID: "${evt.transcript}"`
      );
    }
  });

  openaiWs.on("close", () => {
    console.log(`[${new Date().toISOString()}] OpenAI WS closed`);
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  openaiWs.on("error", (e) => {
    console.error("OpenAI WS error:", e.message);
  });
});

httpServer.listen(PORT, () => {
  console.log(`✅ DES inbound + STT live on ${PORT}`);
});
