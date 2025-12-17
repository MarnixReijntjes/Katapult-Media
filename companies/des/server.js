import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { spawn } from "child_process";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.PUBLIC_BASE_URL;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID;
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL;

const INSTRUCTIONS = process.env.INSTRUCTIONS_INBOUND;
const HANGUP_TOKEN = process.env.HANGUP_TOKEN || "AFRONDEN_OK";

/* ================= ELEVEN TTS ================= */
async function elevenSpeakUlaw(text, pushFrame) {
  const ff = spawn("ffmpeg", [
    "-i", "pipe:0",
    "-ar", "8000",
    "-ac", "1",
    "-f", "mulaw",
    "pipe:1"
  ]);

  ff.stdout.on("data", pushFrame);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE}/stream`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({ model_id: ELEVEN_MODEL, text })
    }
  );

  const { Readable } = await import("stream");
  Readable.fromWeb(res.body).pipe(ff.stdin);

  await new Promise(r => ff.on("close", r));
}

/* ================= HTTP ================= */
const server = http.createServer((req, res) => {
  if (req.url === "/twiml") {
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(`
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/ws"/>
  </Connect>
</Response>
    `.trim());
    return;
  }
  res.writeHead(404);
  res.end();
});

/* ================= WS ================= */
const wss = new WebSocketServer({ server });

wss.on("connection", twilioWs => {
  let streamSid;
  let speaking = false;
  let hangupTimer = null;

  const audioBuffer = [];
  function sendFrame(frame) {
    if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
    twilioWs.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: frame.toString("base64") }
    }));
  }

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  openaiWs.on("open", () => {
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text"],
        instructions: INSTRUCTIONS,
        input_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { type: "server_vad" }
      }
    }));
  });

  let transcript = "";

  openaiWs.on("message", async raw => {
    const evt = JSON.parse(raw);

    if (evt.type === "response.audio_transcript.delta") {
      transcript += evt.delta;
    }

    if (evt.type === "response.audio_transcript.done") {
      const text = transcript.trim();
      transcript = "";

      if (!text) return;

      speaking = true;
      await elevenSpeakUlaw(text, sendFrame);
      speaking = false;

      if (text.includes(HANGUP_TOKEN)) {
        hangupTimer = setTimeout(() => {
          twilioWs.close();
        }, 2500);
      }
    }

    if (evt.type === "input_audio_buffer.speech_started") {
      if (hangupTimer) {
        clearTimeout(hangupTimer);
        hangupTimer = null;
      }
    }
  });

  twilioWs.on("message", msg => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      streamSid = data.start.streamSid;

      elevenSpeakUlaw(
        "Hoi, met Tessa van Move2Go Solutions.",
        sendFrame
      );
    }

    if (data.event === "media") {
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: data.media.payload
      }));
    }

    if (data.event === "stop") {
      openaiWs.close();
    }
  });

});

/* ================= START ================= */
server.listen(PORT, () =>
  console.log(`✅ DES inbound live on ${PORT}`)
);
