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

const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_LIST_ID = process.env.TRELLO_LIST_ID;

const INSTRUCTIONS =
  process.env.INSTRUCTIONS ||
  `
Je bent Tessa, een natuurlijke vrouwelijke telefonische AI-assistent.
Je spreekt duidelijk, warm en natuurlijk Nederlands.
Je spreekt ALLEEN een andere taal als de beller dat doet.
De beller zit op een normale telefoonlijn — geen camera, geen scherm, geen functies.
Je geeft één kort, menselijk, vloeiend antwoord per beurt.
Je geeft GEEN JSON, GEEN functies, GEEN code, GEEN tools.
Je blijft volledig in een natuurlijk telefoon-gesprek.
`;

// ------------------------------------------------------------
// Twilio client
// ------------------------------------------------------------
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ------------------------------------------------------------
// TTS → MP3 (Alloy)
// ------------------------------------------------------------
async function generateTTS(text) {
  console.log("🎤 TTS text:", text);

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
async function convertToMulaw(mp3Buffer) {
  const tmpIn = `/tmp/in_${Date.now()}.mp3`;
  const tmpOut = `/tmp/out_${Date.now()}.wav`;

  fs.writeFileSync(tmpIn, mp3Buffer);

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

  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, (err) => {
      try {
        fs.unlinkSync(tmpIn);
      } catch {}

      if (err) {
        console.error("FFmpeg error:", err);
        return reject(err);
      }

      const out = fs.readFileSync(tmpOut);
      try {
        fs.unlinkSync(tmpOut);
      } catch {}

      resolve(out);
    });
  });
}

// ------------------------------------------------------------
// Send μ-law → Twilio
// ------------------------------------------------------------
function sendMulawToTwilio(ws, sid, mulawBuf) {
  const frameSize = 160; // 20ms

  for (let i = 0; i < mulawBuf.length; i += frameSize) {
    const frame = mulawBuf.subarray(i, i + frameSize);

    if (ws.readyState !== WebSocket.OPEN) return;

    ws.send(
      JSON.stringify({
        event: "media",
        streamSid: sid,
        media: {
          payload: frame.toString("base64")
        }
      })
    );
  }
}

// ------------------------------------------------------------
// Normalize NL phone
// ------------------------------------------------------------
function normalizePhone(raw) {
  if (!raw) return null;
  let cleaned = raw.trim();

  if (cleaned.startsWith("+")) {
    return "+" + cleaned.slice(1).replace(/\D/g, "");
  }

  cleaned = cleaned.replace(/\D/g, "");

  if (cleaned.length === 10 && cleaned.startsWith("06")) {
    return "+31" + cleaned.slice(1);
  }

  if (cleaned.length === 11 && cleaned.startsWith("31")) {
    return "+" + cleaned;
  }

  if (cleaned.length === 9 && cleaned.startsWith("6")) {
    return "+316" + cleaned.slice(1);
  }

  return null;
}

// ------------------------------------------------------------
// Outbound call (Trello)
// ------------------------------------------------------------
async function startOutboundCall(phone) {
  console.log("📞 Outbound call:", phone);

  const call = await twilioClient.calls.create({
    to: phone,
    from: TWILIO_FROM,
    url: `${PUBLIC_BASE_URL}/twiml`
  });

  return call.sid;
}

// ------------------------------------------------------------
// HTTP server (TwiML)
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

  if (req.url.startsWith("/call-test")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const phone = normalizePhone(url.searchParams.get("phone"));

    if (!phone) {
      res.writeHead(400);
      return res.end("Invalid phone");
    }

    startOutboundCall(phone)
      .then(() => {
        res.writeHead(200);
        res.end("ok");
      })
      .catch((e) => {
        res.writeHead(500);
        res.end(e.message);
      });

    return;
  }

  res.writeHead(404).end();
});

// ------------------------------------------------------------
// Twilio Media Streams WebSocket
// ------------------------------------------------------------
const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log(`[SERVER] Running on ${PORT}`);
});

// ------------------------------------------------------------
// MAIN: Realtime NLU → TEXT → Alloy TTS → Twilio audio
// ------------------------------------------------------------
function handleCall(twilioWs, id) {
  console.log("📞 Twilio connected:", id);

  let streamSid = null;
  let partial = "";

  // OpenAI realtime
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

    ai.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text"], // ONLY TEXT OUTPUT
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
      })
    );
  });

  // Twilio → OpenAI audio
  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw);

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
    }

    if (msg.event === "media") {
      ai.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload
        })
      );
    }

    if (msg.event === "stop") {
      ai.close();
    }
  });

  // OpenAI → TEXT → TTS → Twilio
  ai.on("message", async (raw) => {
    const ev = JSON.parse(raw);

    if (ev.type === "response.text.delta") {
      partial += ev.delta || "";
    }

    if (ev.type === "response.text.done") {
      const text = partial.trim();
      partial = "";

      if (!text) return;

      console.log("🗣 AI says:", text);

      try {
        const mp3 = await generateTTS(text);
        const mulaw = await convertToMulaw(mp3);
        sendMulawToTwilio(twilioWs, streamSid, mulaw);
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
}

wss.on("connection", (ws, req) => {
  const id = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  handleCall(ws, id);
});

// ------------------------------------------------------------
// Trello poller
// ------------------------------------------------------------
async function pollTrello() {
  if (!TRELLO_KEY || !TRELLO_TOKEN || !TRELLO_LIST_ID) return;

  try {
    const url = `https://api.trello.com/1/lists/${TRELLO_LIST_ID}/cards?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
    const res = await fetch(url);

    if (!res.ok) return;

    const cards = await res.json();

    for (const card of cards) {
      const labeled = (card.labels || []).some((l) => l.name === "GEBELD");
      if (labeled) continue;

      const m = (card.desc || "").match(/(\+?[0-9][0-9()\-\s]{7,20})/);
      if (!m) continue;

      const phone = normalizePhone(m[0]);
      if (!phone) continue;

      console.log("📞 Trello outbound:", phone);

      try {
        await startOutboundCall(phone);

        // Label card as called
        await fetch(
          `https://api.trello.com/1/cards/${card.id}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "GEBELD", color: "green" })
          }
        );
      } catch (err) {
        console.error("Trello outbound error:", err.message);
      }
    }
  } catch (e) {
    console.error("Trello poll error:", e.message);
  }
}

setInterval(pollTrello, 15000);
