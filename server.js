// ============================================================
//  server.js (CLEAN REWRITE) — DEEL 1/3
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
// ENV CHECKS
// ------------------------------------------------------------

const PORT = process.env.PORT || 8080;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!PUBLIC_BASE_URL) throw new Error("Missing PUBLIC_BASE_URL");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) console.warn("⚠️ Twilio auth missing");
if (!TWILIO_FROM) console.warn("⚠️ TWILIO_FROM missing");

// Twilio client
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// ------------------------------------------------------------
// BASIC NLU INSTRUCTIONS (USED BY OPENAI REALTIME TEXT MODE)
// ------------------------------------------------------------
const INSTRUCTIONS = `
You are Tessa, a friendly, professional Dutch female voice agent.
Default language: Dutch.
If the caller speaks English, switch to English automatically.
Keep responses short, clear and natural.
`;

// ------------------------------------------------------------
//  OPENAI TEXT → TTS (ALLOY) — HIGH QUALITY
// ------------------------------------------------------------

async function generateTTS(text) {
  const url = "https://api.openai.com/v1/audio/speech";

  const body = {
    model: "gpt-4o-mini-tts",     // best-quality TTS
    voice: "alloy",               // natural alloy female
    input: text,
    format: "mp3"                 // predictable format
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error("OpenAI TTS failed: " + err);
  }

  // returns ArrayBuffer
  return Buffer.from(await res.arrayBuffer());
}

// ------------------------------------------------------------
//  DSP → 8kHz → μ-law (minimal DSP per telephone limits)
// ------------------------------------------------------------

async function convertToPhoneMulaw(inputMp3Buffer) {
  const tmpIn = `/tmp/tts_in_${Date.now()}.mp3`;
  const tmpOut = `/tmp/tts_out_${Date.now()}.wav`;

  fs.writeFileSync(tmpIn, inputMp3Buffer);

  const args = [
    "-y",
    "-i", tmpIn,
    "-af",
    "highpass=f=300,lowpass=f=3400,dynaudnorm", // minimal DSP (natural alloy)
    "-ar", "8000",
    "-ac", "1",
    "-c:a", "pcm_mulaw",
    tmpOut
  ];

  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, (err) => {
      try { fs.unlinkSync(tmpIn); } catch {}
      if (err) return reject(err);

      const outBuf = fs.readFileSync(tmpOut);
      try { fs.unlinkSync(tmpOut); } catch {}

      resolve(outBuf);
    });
  });
}

// ------------------------------------------------------------
//  SEND μ-law audio to Twilio Media Stream
// ------------------------------------------------------------
function sendMulawToTwilio(ws, streamSid, mulawBuffer) {
  // Twilio expects base64 payload
  const payload = mulawBuffer.toString("base64");

  const msg = {
    event: "media",
    streamSid,
    media: { payload }
  };

  ws.send(JSON.stringify(msg));
}

// ------------------------------------------------------------
//  OUTBOUND CALL HELPER
// ------------------------------------------------------------

async function startOutboundCall(phone) {
  if (!twilioClient) throw new Error("Twilio not configured");

  const call = await twilioClient.calls.create({
    to: phone,
    from: TWILIO_FROM,
    url: `${PUBLIC_BASE_URL}/twiml`
  });

  return call.sid;
}

// ------------------------------------------------------------
//  SIMPLE NL PHONE NORMALIZER (same as before)
// ------------------------------------------------------------

function normalizePhone(raw) {
  if (!raw) return null;
  let t = raw.toString().trim();

  if (t.startsWith("+")) {
    const digits = t.slice(1).replace(/\D/g, "");
    return "+" + digits;
  }

  const d = t.replace(/\D/g, "");
  if (d.length === 10 && d.startsWith("06")) return "+31" + d.slice(1);
  if (d.length === 11 && d.startsWith("31")) return "+" + d;
  if (d.length === 9 && d.startsWith("6")) return "+31" + d;

  return null;
}

// ============================================================
//  EINDE DEEL 1 — Wacht op DEEL 2
// ============================================================

// ============================================================
//  server.js (CLEAN REWRITE) — DEEL 2/3
// ============================================================

// ------------------------------------------------------------
// HTTP SERVER (health, twiml, call-test)
// ------------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // ----------------------------------------------------------
  // Health endpoint
  // ----------------------------------------------------------
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", time: new Date().toISOString() }));
    return;
  }

  // ----------------------------------------------------------
  // TwiML endpoint for Twilio → connects Media Stream WebSocket
  // ----------------------------------------------------------
  if (req.url === "/twiml" && req.method === "POST") {
    const wsUrl = `wss://${req.headers.host}`;
    const twiml = `
      <Response>
        <Connect>
          <Stream url="${wsUrl}" />
        </Connect>
      </Response>
    `.trim();

    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml);
    return;
  }

  // ----------------------------------------------------------
  // /call-test?phone=0612345678
  // ----------------------------------------------------------
  if (req.url.startsWith("/call-test")) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const phoneRaw = urlObj.searchParams.get("phone");
    if (!phoneRaw) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing phone param" }));
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

  // ----------------------------------------------------------
  // 404 fallback
  // ----------------------------------------------------------
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

// ------------------------------------------------------------
// WebSocket Server for Twilio Media Streams
// ------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Server listening on ${PORT}`);
});

// ============================================================
// REALTIME: OpenAI NLU (text only) + TTS output back to Twilio
// ============================================================

function handleTwilioCall(twilioWs, clientId) {
  console.log(`📞 Twilio connected: ${clientId}`);

  let streamSid = null;

  // ----------------------------------------------------------
  // 1. CONNECT to OpenAI Realtime for text NLU
  // ----------------------------------------------------------
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  let openaiReady = false;

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
        prefix_padding_ms: 200,
        silence_duration_ms: 400,
        create_response: true
      }
    }
  };

  openaiWs.send(JSON.stringify(sessionConfig));

  // eerste begroeting
  setTimeout(() => {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          instructions:
            "Groet de beller in het Nederlands als een vriendelijke vrouwelijke medewerker en leg kort uit dat je een virtuele assistent bent. Vraag hoe je kunt helpen.",
          modalities: ["text"]
        }
      }));
    }
  }, 200);
});


  // ----------------------------------------------------------
  // 2. Twilio → audio → OpenAI (speech to text)
  // ----------------------------------------------------------
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

  // ----------------------------------------------------------
  // 3. OpenAI → TEXT ONLY → We generate TTS per completed response
  // ----------------------------------------------------------

let currentText = "";

openaiWs.on("message", async (data) => {
  const event = JSON.parse(data);

  // tekst komt in stukjes
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
    currentText += event.delta;
  }

  // tekst is klaar → TTS → DSP → naar Twilio
  if (event.type === "response.output_text.done") {
    const text = currentText.trim();
    currentText = "";
    if (!text) return;

    console.log("💬 Tessa zegt:", text);

    try {
      const mp3 = await generateTTS(text);
      const mulaw = await convertToPhoneMulaw(mp3);

      const frameSize = 160; // 20ms @ 8kHz μ-law
      for (let off = 0; off < mulaw.length; off += frameSize) {
        const frame = mulaw.subarray(off, off + frameSize);
        sendMulawToTwilio(twilioWs, streamSid, frame);
      }
    } catch (err) {
      console.error("TTS/DSP error:", err.message);
    }
  }

  if (event.type === "error") {
    console.error("OpenAI error event:", JSON.stringify(event.error || event));
  }
});


  // ----------------------------------------------------------
  // 4. Cleanup
  // ----------------------------------------------------------
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

// ============================================================
//  EINDE DEEL 2 — Wacht op DEEL 3
// ============================================================

// ============================================================
//  server.js (CLEAN REWRITE) — DEEL 3/3
// ============================================================

// ------------------------------------------------------------
// TRELLO POLLER (keeps your outbound flow intact)
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
      // skip already called
      const called = (card.labels || []).some(l => l.name === "GEBELD");
      if (called) continue;

      // extract phone
      const desc = card.desc || "";
      const match = desc.match(/(\+?[0-9][0-9()\-\s]{7,20})/);
      if (!match) continue;

      const raw = match[0].trim();
      const phone = normalizePhone(raw);
      if (!phone) {
        console.warn("⚠️ Skipped invalid phone:", raw);
        continue;
      }

      console.log("📞 Trello outbound call:", phone);

      try {
        await startOutboundCall(phone);

        // set label
        const addLabelUrl =
          `https://api.trello.com/1/cards/${card.id}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;

        await fetch(addLabelUrl, {
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

// Poll every 15 seconds
setInterval(pollTrello, 15000);

// ------------------------------------------------------------
// Graceful Shutdown
// ------------------------------------------------------------

function shutdown() {
  console.log("\nShutting down gracefully…");

  wss.close(() => {
    httpServer.close(() => {
      console.log("Shutdown complete");
      process.exit(0);
    });
  });

  // force quit after 10s
  setTimeout(() => process.exit(1), 10000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ------------------------------------------------------------
// END OF FILE
// ============================================================



