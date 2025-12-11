// ============================================================
//  server.js — Clean rewrite: Realtime NLU → TTS per zin
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
// ENV & CONFIG
// ------------------------------------------------------------

const PORT = process.env.PORT || 8080;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!PUBLIC_BASE_URL) throw new Error("Missing PUBLIC_BASE_URL");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.warn("⚠️ Twilio auth missing");
}
if (!TWILIO_FROM) {
  console.warn("⚠️ TWILIO_FROM missing");
}

// Twilio client
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// NLU instructions
const INSTRUCTIONS = `
You are Tessa, a friendly, professional Dutch female voice agent.
Default language: Dutch.
If the caller speaks English, switch to English automatically.
Keep responses short, clear and natural.
`;

// ------------------------------------------------------------
// OpenAI TTS (alloy, high quality, no pitch hacks)
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

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error("OpenAI TTS failed: " + err);
  }

  return Buffer.from(await res.arrayBuffer());
}

// ------------------------------------------------------------
// DSP → 8kHz μ-law (minimal, natuurlijke alloy-stem)
// ------------------------------------------------------------

async function convertToPhoneMulaw(inputMp3Buffer) {
  const tmpIn = path.join("/tmp", `tts_in_${Date.now()}.mp3`);
  const tmpOut = path.join("/tmp", `tts_out_${Date.now()}.wav`);

  fs.writeFileSync(tmpIn, inputMp3Buffer);

  const args = [
    "-y",
    "-i",
    tmpIn,
    "-af",
    "highpass=f=300,lowpass=f=3400,dynaudnorm",
    "-ar",
    "8000",
    "-ac",
    "1",
    "-c:a",
    "pcm_mulaw",
    tmpOut
  ];

  await new Promise((resolve, reject) => {
    execFile("ffmpeg", args, (err) => {
      try { fs.unlinkSync(tmpIn); } catch {}
      if (err) return reject(err);
      resolve();
    });
  });

  const buf = fs.readFileSync(tmpOut);
  try { fs.unlinkSync(tmpOut); } catch {}
  return buf;
}

// ------------------------------------------------------------
// Send μ-law frames naar Twilio Media Stream
// ------------------------------------------------------------

function sendMulawToTwilio(ws, streamSid, mulawBuffer) {
  const frameSize = 160; // 20ms @ 8kHz, 1 byte/sample
  for (let off = 0; off < mulawBuffer.length; off += frameSize) {
    const frame = mulawBuffer.subarray(off, off + frameSize);
    if (frame.length === 0) continue;

    const payload = frame.toString("base64");
    const msg = {
      event: "media",
      streamSid,
      media: { payload }
    };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}

// ------------------------------------------------------------
// Outbound call helper
// ------------------------------------------------------------

async function startOutboundCall(phone) {
  if (!twilioClient) throw new Error("Twilio not configured");

  const call = await twilioClient.calls.create({
    to: phone,
    from: TWILIO_FROM,
    url: `${PUBLIC_BASE_URL}/twiml`
  });

  console.log("📞 Outbound call started:", call.sid, phone);
  return call.sid;
}

// ------------------------------------------------------------
// NL phone normalizer (zoals je had)
// ------------------------------------------------------------

function normalizePhone(raw) {
  if (!raw) return null;
  let t = raw.toString().trim();

  if (t.startsWith("+")) {
    const digits = t.slice(1).replace(/\D/g, "");
    if (!digits) return null;
    return "+" + digits;
  }

  const d = t.replace(/\D/g, "");
  if (!d) return null;

  if (d.length === 10 && d.startsWith("06")) return "+31" + d.slice(1);
  if (d.length === 11 && d.startsWith("31")) return "+" + d;
  if (d.length === 9 && d.startsWith("6")) return "+31" + d;

  return null;
}

// ------------------------------------------------------------
// HTTP server: /health, /twiml, /call-test
// ------------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", time: new Date().toISOString() }));
    return;
  }

  if (req.url === "/twiml" && req.method === "POST") {
    const wsUrl = `wss://${req.headers.host}`;
    const twiml = `
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`.trim();

    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml);
    return;
  }

  if (req.url.startsWith("/call-test")) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const phoneRaw = urlObj.searchParams.get("phone");
    if (!phoneRaw) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing phone" }));
      return;
    }

    const phone = normalizePhone(phoneRaw);
    if (!phone) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid phone" }));
      return;
    }

    try {
      await startOutboundCall(phone);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, calling: phone }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

// ------------------------------------------------------------
// WebSocket server (Twilio Media Streams)
// ------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Server listening on ${PORT}`);
});

// ------------------------------------------------------------
// Realtime NLU (text only) + TTS per zin
// ------------------------------------------------------------

function handleTwilioCall(twilioWs, clientId) {
  console.log("📞 Twilio connected:", clientId);
  let streamSid = null;

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  let openaiReady = false;
  let currentText = "";

  openaiWs.on("open", () => {
    openaiReady = true;
    console.log("✅ OpenAI realtime connected");

    const sessionConfig = {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        input_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        instructions: INSTRUCTIONS,
        output_audio_format: null,
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 250,
          silence_duration_ms: 500,
          create_response: true
        }
      }
    };

    openaiWs.send(JSON.stringify(sessionConfig));
  });

  // Twilio → audio → OpenAI
  twilioWs.on("message", (msgStr) => {
    try {
      const msg = JSON.parse(msgStr);

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("Twilio stream started:", streamSid);
      }

      if (msg.event === "media" && openaiReady) {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload
        }));
      }

      if (msg.event === "stop") {
        console.log("Twilio stream stopped");
        if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
      }
    } catch (err) {
      console.error("Twilio WS error:", err.message);
    }
  });

  // OpenAI → text events → TTS → μ-law → Twilio
  openaiWs.on("message", async (data) => {
    const event = JSON.parse(data);

    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      currentText += event.delta;
    }

    if (event.type === "response.output_text.done") {
      const text = currentText.trim();
      currentText = "";
      if (!text) return;

      console.log("💬 Tessa:", text);

      try {
        const mp3 = await generateTTS(text);
        const mulaw = await convertToPhoneMulaw(mp3);
        if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
          sendMulawToTwilio(twilioWs, streamSid, mulaw);
        }
      } catch (err) {
        console.error("TTS/DSP error:", err.message);
      }
    }

    if (event.type === "error") {
      console.error("OpenAI error:", JSON.stringify(event.error || event));
    }
  });

  // Cleanup
  twilioWs.on("close", () => {
    console.log("Twilio disconnected:", clientId);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  openaiWs.on("close", () => {
    console.log("OpenAI closed for:", clientId);
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });
}

wss.on("connection", (ws, req) => {
  const id = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  handleTwilioCall(ws, id);
});

// ------------------------------------------------------------
// Trello poller (zelfde logica, maar eenvoudiger)
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

    if (!res.ok) {
      console.error("❌ Trello error:", await res.text());
      return;
    }

    const cards = await res.json();
    for (const card of cards) {
      const called = (card.labels || []).some(l => l.name === "GEBELD");
      if (called) continue;

      const desc = card.desc || "";
      const match = desc.match(/(\+?[0-9][0-9()\-\s]{7,20})/);
      if (!match) continue;

      const phoneRaw = match[0].trim();
      const phone = normalizePhone(phoneRaw);
      if (!phone) continue;

      console.log("📞 Trello outbound call:", phone);

      try {
        await startOutboundCall(phone);

        const labelUrl =
          `https://api.trello.com/1/cards/${card.id}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
        await fetch(labelUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "GEBELD", color: "green" })
        });
      } catch (err) {
        console.error("❌ Outbound call failed:", err.message);
      }
    }
  } catch (err) {
    console.error("❌ Trello poll error:", err.message);
  }
}

setInterval(pollTrello, 15000);

// ------------------------------------------------------------
// Graceful shutdown
// ------------------------------------------------------------

function shutdown() {
  console.log("Shutting down…");
  wss.close(() => {
    httpServer.close(() => {
      console.log("Shutdown complete");
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 10000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

