// ============================================================
//  server.js — Nieuwe Tessa (Realtime NLU → TTS → Twilio)
// ============================================================

import dotenv from "dotenv";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";

dotenv.config();

// ------------------------------------------------------------
// ENV
// ------------------------------------------------------------

const PORT = process.env.PORT || 8080;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!PUBLIC_BASE_URL) throw new Error("Missing PUBLIC_BASE_URL");

// Twilio client
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// Voice persona
const INSTRUCTIONS = `
You are Tessa, a natural Dutch female AI assistant.
Default Dutch unless caller speaks English.
Keep responses short and natural.
`;

// ------------------------------------------------------------
// OPENAI TTS
// ------------------------------------------------------------

async function generateTTS(text) {
  console.log("🎤 TTS:", text);
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text,
      format: "mp3"
    })
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("❌ TTS error:", err);
    throw new Error("TTS failed");
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

// ------------------------------------------------------------
// MP3 → μ-law (8kHz)
// ------------------------------------------------------------

async function convertToPhoneMulaw(inputMp3Buffer) {
  const tmpIn = `/tmp/tts_in_${Date.now()}.mp3`;
  const tmpOut = `/tmp/tts_out_${Date.now()}.wav`;

  fs.writeFileSync(tmpIn, inputMp3Buffer);

  const args = [
    "-y",
    "-i", tmpIn,
    "-af", "highpass=f=300,lowpass=f=3400,dynaudnorm",
    "-ar", "8000",
    "-ac", "1",
    "-c:a", "pcm_mulaw",
    tmpOut
  ];

  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, (err) => {
      try { fs.unlinkSync(tmpIn); } catch {}
      if (err) return reject(err);
      const out = fs.readFileSync(tmpOut);
      try { fs.unlinkSync(tmpOut); } catch {}
      resolve(out);
    });
  });
}

// ------------------------------------------------------------
// Send μ-law audio → Twilio
// ------------------------------------------------------------

function sendMulawToTwilio(ws, streamSid, mulawBuffer) {
  const frame = 160;

  for (let i = 0; i < mulawBuffer.length; i += frame) {
    const chunk = mulawBuffer.subarray(i, i + frame);
    if (!chunk.length) continue;

    if (ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: chunk.toString("base64") }
    }));
  }
}

// ------------------------------------------------------------
// Phone normalization
// ------------------------------------------------------------

function normalizePhone(raw) {
  if (!raw) return null;
  let t = raw.trim();

  if (t.startsWith("+")) return "+" + t.slice(1).replace(/\D/g, "");

  t = t.replace(/\D/g, "");
  if (t.length === 10 && t.startsWith("06")) return "+31" + t.slice(1);
  if (t.length === 11 && t.startsWith("31")) return "+" + t;
  if (t.length === 9 && t.startsWith("6")) return "+316" + t.slice(1);

  return null;
}

// ------------------------------------------------------------
// Start outbound call
// ------------------------------------------------------------

async function startOutboundCall(num) {
  if (!twilioClient) throw new Error("Twilio not configured");

  const call = await twilioClient.calls.create({
    to: num,
    from: TWILIO_FROM,
    url: `${PUBLIC_BASE_URL}/twiml`
  });

  console.log("📞 Outbound call:", num, call.sid);
  return call.sid;
}

// ------------------------------------------------------------
// HTTP server + TwiML
// ------------------------------------------------------------

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.url === "/twiml" && req.method === "POST") {
    const xml = `
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}" />
  </Connect>
</Response>`;
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(xml);
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// ------------------------------------------------------------
// WebSocket server (Twilio Media)
// ------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log("Server on", PORT);
});

// ------------------------------------------------------------
// HANDLE CALL — Realtime NLU + TTS
// ------------------------------------------------------------

function handleCall(twilioWs, clientId) {
  console.log("📞 Twilio connected:", clientId);

  let streamSid = null;
  let openaiReady = false;
  let partial = "";

  // Connect to OpenAI realtime
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  // --------------------------
  // OpenAI READY
  // --------------------------

  openaiWs.on("open", () => {
    console.log("✅ OpenAI connected");
    openaiReady = true;

    // IMPORTANT: TEXT-ONLY OUTPUT
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text"],
        input_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        instructions: INSTRUCTIONS,
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 250,
          silence_duration_ms: 500,
          create_response: true
        }
      }
    }));
  });

  // --------------------------
  // Twilio → OpenAI (audio)
  // --------------------------

  twilioWs.on("message", (m) => {
    let msg;
    try { msg = JSON.parse(m); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log("📡 streamSid:", streamSid);
    }

    if (msg.event === "media" && openaiReady) {
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: msg.media.payload
      }));
    }

    if (msg.event === "stop") {
      console.log("📡 Twilio STOP");
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    }
  });

  // --------------------------
  // OpenAI TEXT → TTS → Twilio
  // --------------------------

  openaiWs.on("message", async (raw) => {
    const event = JSON.parse(raw);

    // TEXT streaming
    if (event.type === "response.text.delta") {
      partial += event.delta || "";
    }

    if (event.type === "response.text.done") {
      const text = partial.trim();
      partial = "";

      if (!text) return;

      console.log("🔸 FINAL TEXT:", text);

      try {
        const mp3 = await generateTTS(text);
        const mulaw = await convertToPhoneMulaw(mp3);

        if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
          sendMulawToTwilio(twilioWs, streamSid, mulaw);
        }
      } catch (err) {
        console.error("❌ Audio send error:", err.message);
      }
    }
  });

  // Cleanup
  twilioWs.on("close", () => {
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  openaiWs.on("close", () => {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });
}

wss.on("connection", (ws, req) => {
  const id = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  handleCall(ws, id);
});

// ------------------------------------------------------------
// Trello poller
// ------------------------------------------------------------

const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_LIST_ID = process.env.TRELLO_LIST_ID;

async function pollTrello() {
  if (!TRELLO_KEY || !TRELLO_TOKEN || !TRELLO_LIST_ID) return;

  try {
    const res = await fetch(
      `https://api.trello.com/1/lists/${TRELLO_LIST_ID}/cards?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
    );
    if (!res.ok) return;

    const cards = await res.json();

    for (const c of cards) {
      const has = (c.labels || []).some(l => l.name === "GEBELD");
      if (has) continue;

      const m = (c.desc || "").match(/(\+?[0-9][0-9()\-\s]{7,20})/);
      if (!m) continue;

      const phone = normalizePhone(m[0]);
      if (!phone) continue;

      console.log("📞 Trello outbound:", phone);

      await startOutboundCall(phone);

      await fetch(
        `https://api.trello.com/1/cards/${c.id}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "GEBELD", color: "green" })
        }
      );
    }
  } catch (e) {
    console.error("❌ Trello poll err:", e.message);
  }
}

setInterval(pollTrello, 15000);

