import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import http from "http";
import { spawn } from "child_process";

dotenv.config();

/* =======================
   CONFIG
======================= */
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SPEED = parseFloat(process.env.SPEED || "1.0");

const INBOUND_OPENING =
  process.env.INBOUND_OPENING ||
  "Goedemiddag, u spreekt met Tessa, de digitale receptionist van Dutch Empire Security. Waar kan ik u mee helpen?";

const INSTRUCTIONS_INBOUND = process.env.INSTRUCTIONS_INBOUND || "";

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";

if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
if (!ELEVEN_API_KEY) throw new Error("ELEVENLABS_API_KEY missing");
if (!ELEVEN_VOICE_ID) throw new Error("ELEVENLABS_VOICE_ID missing");

/* =======================
   ELEVENLABS → μLAW
======================= */
async function elevenSpeak(text, onUlaw, signal) {
  const ff = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    "pipe:0",
    "-ar",
    "8000",
    "-ac",
    "1",
    "-f",
    "mulaw",
    "pipe:1"
  ]);

  ff.stdout.on("data", onUlaw);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({ model_id: ELEVEN_MODEL, text }),
      signal
    }
  );

  if (!res.ok) throw new Error("ElevenLabs failed");

  const { Readable } = await import("stream");
  Readable.fromWeb(res.body).pipe(ff.stdin);

  await new Promise((r) => ff.on("close", r));
}

/* =======================
   HTTP SERVER
======================= */
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200);
    res.end("ok");
    return;
  }

  res.writeHead(404);
  res.end();
});

/* =======================
   WEBSOCKET SERVER
======================= */
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (twilioWs) => {
  let streamSid;
  let callActive = true;
  let speaking = false;
  let ulawBuffer = Buffer.alloc(0);
  let assistantBuf = "";
  let userTurn = 0;
  let spokenTurn = 0;

  function sendTwilio(payload) {
    if (!callActive) return;
    if (twilioWs.readyState !== WebSocket.OPEN) return;
    twilioWs.send(JSON.stringify(payload));
  }

  function pushUlaw(chunk) {
    ulawBuffer = Buffer.concat([ulawBuffer, chunk]);
    while (ulawBuffer.length >= 160) {
      const frame = ulawBuffer.subarray(0, 160);
      ulawBuffer = ulawBuffer.subarray(160);
      sendTwilio({
        event: "media",
        streamSid,
        media: { payload: frame.toString("base64") }
      });
    }
  }

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  openaiWs.on("open", () => {
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          instructions: INSTRUCTIONS_INBOUND,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            silence_duration_ms: 250
          },
          temperature: 0.6,
          speed: SPEED
        }
      })
    );
  });

  twilioWs.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      elevenSpeak(INBOUND_OPENING, pushUlaw);
      return;
    }

    if (data.event === "media") {
      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload
        })
      );
    }

    if (data.event === "stop") {
      callActive = false;
      openaiWs.close();
    }
  });

  openaiWs.on("message", async (raw) => {
    const evt = JSON.parse(raw);

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      userTurn++;
      return;
    }

    if (evt.type === "response.audio_transcript.delta") {
      assistantBuf += evt.delta;
    }

    if (evt.type === "response.done") {
      if (!assistantBuf.trim()) return;
      if (spokenTurn >= userTurn) return;

      spokenTurn = userTurn;
      const text = assistantBuf.trim();
      assistantBuf = "";

      await elevenSpeak(text, pushUlaw);
    }
  });
});

/* =======================
   START
======================= */
httpServer.listen(PORT, () => {
  console.log("Relay server running on", PORT);
});
