import dotenv from "dotenv";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";
import fs from "fs";
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

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ------------------------------------------------------------
// Tessa persona — FINAALE FIX
// ------------------------------------------------------------

const INSTRUCTIONS = `
Je bent Tessa, een natuurlijke vrouwelijke telefonische AI-assistent.
Je spreekt duidelijk, warm en natuurlijk Nederlands.
Je spreekt ALLEEN een andere taal als de beller dat doet.
De beller zit op een normale telefoonlijn — geen camera, geen scherm, geen functies.
Je geeft één kort, menselijk, vloeiend antwoord per beurt.
Je geeft GEEN JSON, GEEN functies, GEEN code, GEEN tools.
Je blijft volledig in een natuurlijk telefoon-gesprek.
`;

// ------------------------------------------------------------
// OpenAI TTS (Alloy) → MP3
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
    console.error(await res.text());
    throw new Error("TTS failed");
  }

  return Buffer.from(await res.arrayBuffer());
}

// ------------------------------------------------------------
// MP3 → μ-law
// ------------------------------------------------------------

async function convertToMulaw(mp3Buf) {
  const tmpIn = `/tmp/in_${Date.now()}.mp3`;
  const tmpOut = `/tmp/out_${Date.now()}.wav`;

  fs.writeFileSync(tmpIn, mp3Buf);

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
      fs.unlinkSync(tmpIn);
      if (err) return reject(err);

      const out = fs.readFileSync(tmpOut);
      fs.unlinkSync(tmpOut);
      resolve(out);
    });
  });
}

// ------------------------------------------------------------
// Push μ-law → Twilio
// ------------------------------------------------------------

function sendMulaw(ws, sid, buf) {
  const frame = 160;

  for (let i = 0; i < buf.length; i += frame) {
    const chunk = buf.subarray(i, i + frame);
    if (!chunk.length || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
      event: "media",
      streamSid: sid,
      media: { payload: chunk.toString("base64") }
    }));
  }
}

// ------------------------------------------------------------
// Outbound call
// ------------------------------------------------------------

async function callOutbound(num) {
  return await twilioClient.calls.create({
    to: num,
    from: TWILIO_FROM,
    url: `${PUBLIC_BASE_URL}/twiml`
  });
}

// ------------------------------------------------------------
// TwiML
// ------------------------------------------------------------

const httpServer = http.createServer((req, res) => {
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

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  res.writeHead(404);
  res.end();
});

// ------------------------------------------------------------
// Start server
// ------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => console.log("Server running", PORT));

// ------------------------------------------------------------
// MAIN LOGIC — OpenAI NLU + Alloy TTS
// ------------------------------------------------------------

wss.on("connection", (twilioWs, req) => {
  console.log("📞 Twilio connected");

  let streamSid = null;
  let partial = "";

  // --- Connect to OpenAI realtime ---
  const ai = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  ai.on("open", () => {
    console.log("✅ OpenAI connected");

    ai.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text"],   // <— CRUCIAAL
        input_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        instructions: INSTRUCTIONS,
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 250,
          silence_duration_ms: 600,
          create_response: true
        }
      }
    }));
  });

  // --- Twilio → OpenAI ---
  twilioWs.on("message", (m) => {
    const msg = JSON.parse(m);

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
    }

    if (msg.event === "media") {
      ai.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: msg.media.payload
      }));
    }

    if (msg.event === "stop") {
      ai.close();
    }
  });

  // --- OpenAI text → Alloy TTS → Twilio ---
  ai.on("message", async (raw) => {
    const ev = JSON.parse(raw);

    if (ev.type === "response.text.delta") {
      partial += ev.delta || "";
    }

    if (ev.type === "response.text.done") {
      const text = partial.trim();
      partial = "";

      if (!text) return;

      console.log("🔸 AI:", text);

      try {
        const mp3 = await generateTTS(text);
        const mulaw = await convertToMulaw(mp3);
        sendMulaw(twilioWs, streamSid, mulaw);
      } catch (e) {
        console.error("Audio error:", e);
      }
    }
  });

  ai.on("close", () => {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  twilioWs.on("close", () => {
    if (ai.readyState === WebSocket.OPEN) ai.close();
  });

});
