// ============================================================
//  server.js — Nieuwe Tessa: Realtime NLU → TTS → Telefoon
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

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// Voice persona
const INSTRUCTIONS = `
You are Tessa, a natural Dutch female AI assistant.
Default language: Dutch.
If the caller speaks English, switch automatically.
Keep answers short and natural.
`;

// ------------------------------------------------------------
// OPENAI TTS → MP3
// ------------------------------------------------------------

async function generateTTS(text) {
  console.log("🎤 GENERATING TTS:", text);
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
  console.log("🎤 MP3 SIZE:", buf.length);
  return buf;
}

// ------------------------------------------------------------
// DSP → μ-law (8kHz)
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
      if (err) {
        console.error("❌ ffmpeg:", err.message);
        return reject(err);
      }
      const out = fs.readFileSync(tmpOut);
      try { fs.unlinkSync(tmpOut); } catch {}
      console.log("🎧 MULAW SIZE:", out.length);
      resolve(out);
    });
  });
}

// ------------------------------------------------------------
// μ-law → Twilio Media Stream
// ------------------------------------------------------------

function sendMulawToTwilio(ws, streamSid, mulawBuffer) {
  const frameSize = 160; // 20ms
  console.log("📡 SENDING MULAW:", mulawBuffer.length);

  for (let off = 0; off < mulawBuffer.length; off += frameSize) {
    const frame = mulawBuffer.subarray(off, off + frameSize);
    if (!frame.length) continue;

    const payload = frame.toString("base64");
    const packet = {
      event: "media",
      streamSid,
      media: { payload }
    };

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(packet));
    }
  }

  console.log("📡 DONE");
}

// ------------------------------------------------------------
// Telefoonnummer normalisatie (NL)
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
// Outbound call
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
// HTTP + TwiML
// ------------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === "/twiml" && req.method === "POST") {
    const wsUrl = `wss://${req.headers.host}`;
    const xml = `
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(xml);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// ------------------------------------------------------------
// WebSocket (Twilio Media Streams)
// ------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log("Server on", PORT);
});

// ------------------------------------------------------------
// MAIN CALL HANDLER — Realtime NLU → TTS → Twilio
// ------------------------------------------------------------

function handleCall(twilioWs, clientId) {
  console.log("📞 Twilio connected:", clientId);

  let streamSid = null;
  let openaiReady = false;
  let partial = "";

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  // ----------------------
  // OpenAI connected
  // ----------------------

  openaiWs.on("open", () => {
    console.log("✅ OpenAI realtime connected");
    openaiReady = true;

    // IMPORTANT FIX: ONLY TEXT OUTPUT
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text"],     // ← FIX
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

  // ----------------------
  // Twilio → audio → OpenAI
  // ----------------------

  twilioWs.on("message", (msgStr) => {
    let msg;
    try { msg = JSON.parse(msgStr); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log("📡 STREAM SID:", streamSid);
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

  // ----------------------
  // OpenAI → TEXT → TTS → μ-law → Twilio
  // ----------------------

  openaiWs.on("message", async (raw) => {
    const event = JSON.parse(raw);
    console.log("🛰", event.type);

    // TEXT-STREAMING
    if (event.type === "response.output_text.delta") {
      console.log("🔹 TEXT-DELTA:", event.delta);
      partial += event.delta || "";
    }

    if (event.type === "response.output_text.done") {
      const text = partial.trim();
      console.log("🔸 TEXT-DONE:", text);
      partial = "";

      if (!text) return;

      try {
        const mp3 = await generateTTS(text);
        const mulaw = await convertToPhoneMulaw(mp3);

        if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
          sendMulawToTwilio(twilioWs, streamSid, mulaw);
        } else {
          console.log("⚠️ Twilio closed before send");
        }
      } catch (err) {
        console.error("❌ TTS/DSP:", err.message);
      }
    }
  });

  // cleanup
  twilioWs.on("close", () => {
    console.log("📴 Twilio disconnected");
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  openaiWs.on("close", () => {
    console.log("📴 OpenAI closed");
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
    const url =
      `https://api.trello.com/1/lists/${TRELLO_LIST_ID}/cards?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;

    const res = await fetch(url);
    if (!res.ok) return;

    const cards = await res.json();

    for (const card of cards) {
      const hasLabel = (card.labels || []).some(l => l.name === "GEBELD");
      if (hasLabel) continue;

      const m = (card.desc || "").match(/(\+?[0-9][0-9()\-\s]{7,20})/);
      if (!m) continue;

      const phone = normalizePhone(m[0]);
      if (!phone) continue;

      console.log("📞 Trello outbound:", phone);

      try {
        await startOutboundCall(phone);

        await fetch(
          `https://api.trello.com/1/cards/${card.id}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "GEBELD", color: "green" })
          }
        );
      } catch (err) {
        console.error("❌ Trello/call:", err.message);
      }
    }
  } catch (err) {
    console.error("❌ Trello poll:", err.message);
  }
}

setInterval(pollTrello, 15000);
