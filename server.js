// ============================================================
//  server.js — Final Stable Version (NLU → TTS → Phone)
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
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) console.warn("⚠️ Twilio credentials missing");
if (!TWILIO_FROM) console.warn("⚠️ TWILIO_FROM missing");

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// Voice persona instructions
const INSTRUCTIONS = `
You are Tessa, a natural Dutch female AI assistant.
Speak short, clear Dutch by default.
If the caller uses English, switch to English automatically.
Be friendly, professional and human-like.
`;

// ------------------------------------------------------------
// OPENAI TTS (alloy → mp3)
// ------------------------------------------------------------

async function generateTTS(text) {
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

  if (!res.ok) throw new Error(await res.text());
  return Buffer.from(await res.arrayBuffer());
}

// ------------------------------------------------------------
// DSP → 8kHz μ-law (minimal)
// ------------------------------------------------------------

async function convertToPhoneMulaw(inputMp3Buffer) {
  const tmpIn = `/tmp/in_${Date.now()}.mp3`;
  const tmpOut = `/tmp/out_${Date.now()}.wav`;

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

  await new Promise((resolve, reject) => {
    execFile("ffmpeg", args, (err) => {
      try { fs.unlinkSync(tmpIn); } catch {}
      if (err) return reject(err);
      resolve();
    });
  });

  const out = fs.readFileSync(tmpOut);
  try { fs.unlinkSync(tmpOut); } catch {}
  return out;
}

// ------------------------------------------------------------
// SEND μ-law to Twilio
// ------------------------------------------------------------

function sendMulawToTwilio(ws, streamSid, mulawBuffer) {
  const frameSize = 160; // 20ms @ 8kHz

  for (let off = 0; off < mulawBuffer.length; off += frameSize) {
    const frame = mulawBuffer.subarray(off, off + frameSize);
    const payload = frame.toString("base64");

    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload }
    }));
  }
}

// ------------------------------------------------------------
// NORMALIZE NL PHONE
// ------------------------------------------------------------

function normalizePhone(raw) {
  if (!raw) return null;
  let t = raw.trim();

  if (t.startsWith("+")) return "+" + t.slice(1).replace(/\D/g, "");
  const d = t.replace(/\D/g, "");
  if (d.length === 10 && d.startsWith("06")) return "+31" + d.slice(1);
  if (d.length === 11 && d.startsWith("31")) return "+" + d;
  if (d.length === 9 && d.startsWith("6")) return "+316" + d.slice(1);
  return null;
}

// ------------------------------------------------------------
// START OUTBOUND CALL
// ------------------------------------------------------------

async function startOutboundCall(phone) {
  if (!twilioClient) throw new Error("Twilio not configured");

  const call = await twilioClient.calls.create({
    to: phone,
    from: TWILIO_FROM,
    url: `${PUBLIC_BASE_URL}/twiml`
  });

  console.log("📞 Outbound call:", phone, call.sid);
  return call.sid;
}

// ------------------------------------------------------------
// HTTP SERVER
// ------------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
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

  if (req.url.startsWith("/call-test")) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const raw = urlObj.searchParams.get("phone");
    const phone = normalizePhone(raw);

    if (!phone) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid phone" }));
      return;
    }

    try {
      await startOutboundCall(phone);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// ------------------------------------------------------------
// WEBSOCKET SERVER (Twilio Media Stream)
// ------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () =>
  console.log(`[${new Date().toISOString()}] Server on ${PORT}`)
);

// ------------------------------------------------------------
// REALTIME NLU (TEXT ONLY) + TTS RESPONSE
// ------------------------------------------------------------

function handleTwilioCall(twilioWs, clientId) {
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

  // OpenAI startup
  openaiWs.on("open", () => {
    openaiReady = true;
    console.log("✅ OpenAI realtime connected");

    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
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

  // Twilio audio in → OpenAI
  twilioWs.on("message", (msgStr) => {
    let msg;
    try { msg = JSON.parse(msgStr); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log("Twilio stream:", streamSid);
    }

    if (msg.event === "media" && openaiReady) {
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: msg.media.payload
      }));
    }

    if (msg.event === "stop") {
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    }
  });

  // OpenAI → text events → TTS → Twilio
  openaiWs.on("message", async (data) => {
    const event = JSON.parse(data);

    if (event.type === "response.output_text.delta") {
      partial += event.delta || "";
    }

    if (event.type === "response.output_text.done") {
      const text = partial.trim();
      partial = "";
      if (!text) return;

      console.log("💬 Tessa:", text);

      try {
        const mp3 = await generateTTS(text);
        const mulaw = await convertToPhoneMulaw(mp3);
        if (twilioWs.readyState === WebSocket.OPEN) {
          sendMulawToTwilio(twilioWs, streamSid, mulaw);
        }
      } catch (err) {
        console.error("❌ TTS error:", err.message);
      }
    }

    if (event.type === "error") {
      console.error("OpenAI error:", JSON.stringify(event.error));
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
  handleTwilioCall(ws, id);
});

// ------------------------------------------------------------
// TRELLO POLLER
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
    const cards = await res.json();

    for (const card of cards) {
      const already = (card.labels || []).some(l => l.name === "GEBELD");
      if (already) continue;

      const desc = card.desc || "";
      const match = desc.match(/(\+?[0-9][0-9()\-\s]{7,20})/);
      if (!match) continue;

      const phone = normalizePhone(match[0]);
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
        console.error("❌ Call/Trello error:", err.message);
      }
    }
  } catch (err) {
    console.error("❌ Trello poll error:", err.message);
  }
}

setInterval(pollTrello, 15000);

// ------------------------------------------------------------
// SHUTDOWN
// ------------------------------------------------------------

function shutdown() {
  console.log("Shutting down…");
  wss.close(() => {
    httpServer.close(() => {
      process.exit(0);
    });
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
