// companies/des/server.js
import dotenv from "dotenv";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { spawn } from "child_process";
import { Readable } from "stream";
import crypto from "crypto";

dotenv.config();

const PORT = process.env.PORT || 10000;

const INBOUND_GREETING = process.env.INBOUND_GREETING || "Hoi, met Tessa van DES.";
const INSTRUCTIONS_INBOUND =
  process.env.INSTRUCTIONS_INBOUND ||
  "Je bent Tessa, inbound receptionist. Antwoord kort, vriendelijk, 1 vraag tegelijk. Nederlands.";

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY missing");
  process.exit(1);
}
if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
  console.error("❌ ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID missing");
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
function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

/* =========================
   ElevenLabs greeting cache (mp3 for <Play>)
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

  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error("ELEVEN_EMPTY_AUDIO");
  return buf;
}

/* =========================
   ElevenLabs streaming -> ffmpeg -> ulaw bytes callback
   Supports AbortController for barge-in
========================= */
async function elevenStreamToUlaw(text, onUlawChunk, abortSignal) {
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
    "pipe:1",
  ]);

  ff.stdout.on("data", (chunk) => onUlawChunk(chunk));
  ff.stderr.on("data", () => {});

  const cleanup = () => {
    try {
      ff.stdin.end();
    } catch {}
    try {
      ff.kill("SIGKILL");
    } catch {}
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      cleanup();
      return;
    }
    abortSignal.addEventListener(
      "abort",
      () => {
        cleanup();
      },
      { once: true }
    );
  }

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({ model_id: ELEVEN_MODEL, text }),
      signal: abortSignal,
    }
  ).catch((e) => {
    if (abortSignal?.aborted) return null;
    throw e;
  });

  if (!res) {
    cleanup();
    return;
  }

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    cleanup();
    throw new Error(`ELEVEN_STREAM_FAILED ${res.status}: ${err}`);
  }

  const nodeStream = Readable.fromWeb(res.body);

  const stopNodeStream = () => {
    try {
      nodeStream.destroy();
    } catch {}
    try {
      ff.stdin.end();
    } catch {}
  };

  if (abortSignal) {
    abortSignal.addEventListener(
      "abort",
      () => {
        stopNodeStream();
        cleanup();
      },
      { once: true }
    );
  }

  nodeStream.on("data", (d) => {
    if (abortSignal?.aborted) return;
    ff.stdin.write(d);
  });
  nodeStream.on("end", () => {
    try {
      ff.stdin.end();
    } catch {}
  });
  nodeStream.on("error", () => {
    try {
      ff.stdin.end();
    } catch {}
  });

  await new Promise((resolve) => {
    ff.on("close", resolve);
    ff.on("error", resolve);
  });
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
        service: "des-inbound-eleven-greeting-openai-reply-barge-in-anti-double",
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
      } else {
        console.log(`[${new Date().toISOString()}] ♻️ Using cached greeting mp3`);
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

      console.log(
        `[${new Date().toISOString()}] TwiML served <Play> + <Stream> ws=${wsUrl}`
      );
      return sendXml(res, twiml);
    }

    if (path === "/audio.mp3" && req.method === "GET") {
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
   WebSockets: Twilio -> OpenAI -> Eleven -> Twilio
   - barge-in
   - anti-double: speak only on response.audio_transcript.done
========================= */
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (twilioWs, req) => {
  if (req.url !== "/ws") {
    twilioWs.close();
    return;
  }

  let streamSid = null;
  console.log(`[${new Date().toISOString()}] WS connected url=${req.url}`);

  // ulaw frame packing: 20ms @ 8kHz mono = 160 bytes
  let ulawBuf = Buffer.alloc(0);
  function pushUlaw(chunk) {
    ulawBuf = Buffer.concat([ulawBuf, chunk]);
    const frameSize = 160;
    while (ulawBuf.length >= frameSize) {
      const frame = ulawBuf.subarray(0, frameSize);
      ulawBuf = ulawBuf.subarray(frameSize);

      if (twilioWs.readyState !== WebSocket.OPEN || !streamSid) return;
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: frame.toString("base64") },
        })
      );
    }
  }

  // ----- BARGE-IN STATE -----
  let speechToken = 0;
  let currentSpeech = null; // { token, abortController }

  function cancelSpeech(reason) {
    if (!currentSpeech) return;
    try {
      currentSpeech.abortController.abort();
    } catch {}
    console.log(`[${new Date().toISOString()}] Speech cancelled reason=${reason}`);
    currentSpeech = null;
  }

  function twilioClear() {
    if (twilioWs.readyState !== WebSocket.OPEN || !streamSid) return;
    twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
  }

  async function speak(text) {
    const t = (text || "").trim();
    if (!t) return;
    if (!streamSid) return;
    if (currentSpeech) return;

    const myToken = speechToken;
    const abortController = new AbortController();
    currentSpeech = { token: myToken, abortController };

    const t0 = Date.now();
    console.log(`[${new Date().toISOString()}] SPEAK_START text="${t.slice(0, 140)}"`);

    try {
      await elevenStreamToUlaw(
        t,
        (chunk) => {
          if (speechToken !== myToken) return;
          if (abortController.signal.aborted) return;
          pushUlaw(chunk);
        },
        abortController.signal
      );

      if (speechToken !== myToken) return;

      console.log(`[${new Date().toISOString()}] SPEAK_DONE ms=${Date.now() - t0}`);
    } catch (e) {
      if (abortController.signal.aborted) return;
      console.error("❌ SPEAK_ERROR:", e.message);
    } finally {
      if (currentSpeech && currentSpeech.token === myToken) {
        currentSpeech = null;
      }
    }
  }

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  function safeOpenAI(obj) {
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(JSON.stringify(obj));
  }

  openaiWs.on("open", () => {
    safeOpenAI({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        instructions: INSTRUCTIONS_INBOUND,
        input_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
        },
        temperature: 0.6,
        max_response_output_tokens: 250,
      },
    });
    console.log(`[${new Date().toISOString()}] OpenAI session.update sent (reply enabled)`);
  });

  // Twilio -> OpenAI audio
  twilioWs.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      console.log(
        `[${new Date().toISOString()}] Twilio start streamSid=${streamSid} callSid=${msg.start?.callSid}`
      );
      return;
    }

    if (msg.event === "media") {
      safeOpenAI({ type: "input_audio_buffer.append", audio: msg.media.payload });
      return;
    }

    if (msg.event === "stop") {
      console.log(`[${new Date().toISOString()}] Twilio stop streamSid=${streamSid}`);
      cancelSpeech("twilio_stop");
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
      return;
    }
  });

  // OpenAI -> speak assistant text
  let assistantBuf = "";
  let assistantSeen = false;

  // Anti-double: speak only on transcript.done + hash dedupe (short window)
  let lastSpokenHash = "";
  let lastSpokenAt = 0;
  const DEDUPE_WINDOW_MS = 5000;

  openaiWs.on("message", async (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }

    if (evt.type === "input_audio_buffer.speech_started") {
      console.log(`[${new Date().toISOString()}] 🎙️ speech_started (barge-in)`);
      speechToken++;
      cancelSpeech("barge_in");
      twilioClear();
      return;
    }

    if (evt.type === "input_audio_buffer.speech_stopped") {
      console.log(`[${new Date().toISOString()}] 🎙️ speech_stopped`);
      return;
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      console.log(`[${new Date().toISOString()}] 📝 USER SAID: "${evt.transcript}"`);
      return;
    }

    if (evt.type === "response.audio_transcript.delta" && typeof evt.delta === "string") {
      assistantSeen = true;
      assistantBuf += evt.delta;
      return;
    }

    // ✅ Speak ONLY here (anti-double)
    if (evt.type === "response.audio_transcript.done") {
      if (!assistantSeen) return;

      const text = assistantBuf.trim();
      assistantBuf = "";
      assistantSeen = false;

      const now = Date.now();
      const h = sha1(text);
      const isDup = h === lastSpokenHash && now - lastSpokenAt < DEDUPE_WINDOW_MS;
      if (!text || isDup) return;

      lastSpokenHash = h;
      lastSpokenAt = now;

      await speak(text);
      return;
    }

    // response.done is intentionally ignored to prevent duplicates

    if (evt.type === "error") {
      console.error(`[${new Date().toISOString()}] ❌ OpenAI error:`, JSON.stringify(evt.error));
    }
  });

  openaiWs.on("close", (code) => {
    console.log(`[${new Date().toISOString()}] OpenAI WS closed code=${code}`);
    cancelSpeech("openai_ws_close");
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  openaiWs.on("error", (e) => {
    console.error(`[${new Date().toISOString()}] OpenAI WS error:`, e.message);
  });

  twilioWs.on("close", () => {
    console.log(`[${new Date().toISOString()}] Twilio WS closed streamSid=${streamSid}`);
    cancelSpeech("twilio_ws_close");
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  twilioWs.on("error", (e) => {
    console.error(`[${new Date().toISOString()}] Twilio WS error:`, e.message);
    cancelSpeech("twilio_ws_error");
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
});

httpServer.listen(PORT, () => {
  console.log(`✅ DES inbound: greeting + STT + reply via Eleven + barge-in + anti-double live on ${PORT}`);
});
