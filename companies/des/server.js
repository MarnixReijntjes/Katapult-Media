// companies/des/server.js
import dotenv from "dotenv";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { spawn } from "child_process";
import { Readable } from "stream";
import crypto from "crypto";

dotenv.config();

/* =======================
   CONFIG
======================= */
const PORT = process.env.PORT || 10000;

const INBOUND_GREETING = process.env.INBOUND_GREETING || "Hoi, met Tessa van DES.";
const INSTRUCTIONS_INBOUND =
  process.env.INSTRUCTIONS_INBOUND ||
  "Je bent Tessa, inbound receptionist. Antwoord kort, vriendelijk, 1 vraag tegelijk. Nederlands.";

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const HANGUP_TOKEN = process.env.HANGUP_TOKEN || "AFRONDEN_OK";
const HANGUP_DELAY_MS = Number(process.env.HANGUP_DELAY_MS || 2500);

if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY missing");
  process.exit(1);
}
if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
  console.error("❌ ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID missing");
  process.exit(1);
}

/* =======================
   HELPERS
======================= */
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
let warming = false;

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

async function warmGreetingCache() {
  if (warming) return;
  warming = true;
  try {
    const t0 = Date.now();
    const mp3 = await synthesizeElevenMp3(INBOUND_GREETING);
    cachedMp3 = mp3;
    cachedText = INBOUND_GREETING;
    cachedAt = Date.now();
    console.log(
      `[${new Date().toISOString()}] 🔥 Warmed greeting cache bytes=${mp3.length} ms=${Date.now() - t0}`
    );
  } catch (e) {
    console.error(`[${new Date().toISOString()}] ❌ Warm greeting failed:`, e.message);
  } finally {
    warming = false;
  }
}

/* =========================
   ElevenLabs streaming -> ffmpeg -> ulaw bytes callback
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
      console.log(`[${new Date().toISOString()}] TwiML hit method=POST url=/twiml`);

      const now = Date.now();
      const cacheValid =
        cachedMp3 &&
        cachedText === INBOUND_GREETING &&
        now - cachedAt < 60 * 60 * 1000;

      if (!cacheValid) {
        warmGreetingCache().catch(() => {});
      }

      const baseUrl = `https://${req.headers.host}`;
      const wsUrl = `wss://${req.headers.host}/ws`;

      let twiml = "";
      if (cacheValid) {
        const audioUrl = `${baseUrl}/audio.mp3?ts=${Date.now()}`;
        twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${escapeXml(audioUrl)}</Play>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" />
  </Connect>
</Response>`;
        console.log(
          `[${new Date().toISOString()}] TwiML served <Play> + <Stream> ws=${wsUrl}`
        );
      } else {
        twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" />
  </Connect>
</Response>`;
        console.log(
          `[${new Date().toISOString()}] TwiML served <Stream-only> (cache warming) ws=${wsUrl}`
        );
      }

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
========================= */
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (twilioWs, req) => {
  if (req.url !== "/ws") {
    twilioWs.close();
    return;
  }

  let streamSid = null;
  console.log(`[${new Date().toISOString()}] WS connected url=${req.url}`);

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

  let speechToken = 0;
  let currentSpeech = null; // { token, abortController }
  let greetingSpokenViaWs = false;

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

  // Hangup state
  let hangupTimer = null;
  let pendingHangupMarkName = null;
  let hangupFailSafeTimer = null;
  let markSeq = 0;

  function cleanupHangupMark(reason) {
    pendingHangupMarkName = null;
    if (hangupFailSafeTimer) {
      clearTimeout(hangupFailSafeTimer);
      hangupFailSafeTimer = null;
    }
    if (reason) {
      console.log(`[${new Date().toISOString()}] Hangup mark cleared reason=${reason}`);
    }
  }

  function startHangupCountdown(reason) {
    if (hangupTimer) clearTimeout(hangupTimer);
    hangupTimer = setTimeout(() => {
      console.log(`[${new Date().toISOString()}] Hanging up reason=${reason}`);
      try {
        twilioWs.close();
      } catch {}
    }, HANGUP_DELAY_MS);

    console.log(
      `[${new Date().toISOString()}] Hangup armed in ${HANGUP_DELAY_MS}ms reason=${reason}`
    );
  }

  function sendMark(name) {
    if (twilioWs.readyState !== WebSocket.OPEN || !streamSid) return false;
    try {
      twilioWs.send(
        JSON.stringify({
          event: "mark",
          streamSid,
          mark: { name },
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  function armHangup(reason) {
    if (hangupTimer) {
      clearTimeout(hangupTimer);
      hangupTimer = null;
    }
    cleanupHangupMark("rearm");

    const name = `hangup_${Date.now()}_${++markSeq}`;
    const ok = sendMark(name);

    if (ok) {
      pendingHangupMarkName = name;
      console.log(
        `[${new Date().toISOString()}] Hangup armed via MARK name=${name} reason=${reason}`
      );

      const FAILSAFE_MS = Math.max(8000, HANGUP_DELAY_MS + 3000);
      hangupFailSafeTimer = setTimeout(() => {
        console.log(
          `[${new Date().toISOString()}] Hangup MARK timeout -> fallback name=${name} reason=${reason}`
        );
        cleanupHangupMark("mark_timeout");
        startHangupCountdown("token_seen_fallback");
      }, FAILSAFE_MS);
    } else {
      console.log(
        `[${new Date().toISOString()}] Hangup mark send failed -> fallback reason=${reason}`
      );
      cleanupHangupMark("mark_send_failed");
      startHangupCountdown("token_seen_fallback_send_failed");
    }
  }

  function disarmHangup(reason) {
    if (hangupTimer) {
      clearTimeout(hangupTimer);
      hangupTimer = null;
    }
    cleanupHangupMark(reason);
    console.log(`[${new Date().toISOString()}] Hangup disarmed reason=${reason}`);
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

      if (t.includes(HANGUP_TOKEN)) {
        armHangup("token_seen");
      }
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

  // Twilio -> OpenAI audio + MARK acks
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

      const now = Date.now();
      const cacheValid =
        cachedMp3 &&
        cachedText === INBOUND_GREETING &&
        now - cachedAt < 60 * 60 * 1000;

      if (!cacheValid && !greetingSpokenViaWs) {
        greetingSpokenViaWs = true;
        speak(INBOUND_GREETING).catch(() => {});
      }

      return;
    }

    if (msg.event === "media") {
      safeOpenAI({ type: "input_audio_buffer.append", audio: msg.media.payload });
      return;
    }

    if (msg.event === "mark") {
      const name = msg.mark?.name || "";
      console.log(`[${new Date().toISOString()}] Twilio MARK received name=${name}`);

      if (pendingHangupMarkName && name === pendingHangupMarkName) {
        console.log(
          `[${new Date().toISOString()}] Hangup MARK matched -> starting hangup countdown`
        );
        cleanupHangupMark("mark_ack");
        startHangupCountdown("token_seen_mark_ack");
      }
      return;
    }

    if (msg.event === "stop") {
      console.log(`[${new Date().toISOString()}] Twilio stop streamSid=${streamSid}`);
      disarmHangup("twilio_stop");
      cancelSpeech("twilio_stop");
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
      return;
    }
  });

  // OpenAI -> speak assistant text
  // CHANGE: also support response.text.* because audio_transcript.* can be incomplete
  let assistantBuf = "";
  let assistantSeen = false;

  let textBuf = "";
  let textSeen = false;

  let lastSpokenHash = "";
  let lastSpokenAt = 0;
  const DEDUPE_WINDOW_MS = 5000;

  // Guard to prevent speaking twice on both done events
  let spokenForThisTurn = false;

  function maybeSpeakFromBuffers(trigger) {
    if (spokenForThisTurn) return;

    const combined = (assistantBuf.trim() || textBuf.trim()).trim();
    if (!combined) return;

    const now = Date.now();
    const h = sha1(combined);
    const isDup = h === lastSpokenHash && now - lastSpokenAt < DEDUPE_WINDOW_MS;
    if (isDup) return;

    lastSpokenHash = h;
    lastSpokenAt = now;

    spokenForThisTurn = true;

    // reset buffers for next turn
    assistantBuf = "";
    assistantSeen = false;
    textBuf = "";
    textSeen = false;

    speak(combined).catch(() => {});
    console.log(`[${new Date().toISOString()}] SPEAK_TRIGGERED via=${trigger}`);
  }

  openaiWs.on("message", async (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }

    if (evt.type === "input_audio_buffer.speech_started") {
      console.log(`[${new Date().toISOString()}] 🎙️ speech_started (barge-in)`);
      disarmHangup("barge_in");
      speechToken++;
      cancelSpeech("barge_in");
      twilioClear();

      // new user turn begins: allow next assistant speak
      spokenForThisTurn = false;
      assistantBuf = "";
      assistantSeen = false;
      textBuf = "";
      textSeen = false;

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

    if (evt.type === "response.text.delta" && typeof evt.delta === "string") {
      textSeen = true;
      textBuf += evt.delta;
      return;
    }

    if (evt.type === "response.audio_transcript.done") {
      if (!assistantSeen && !textSeen) return;
      maybeSpeakFromBuffers("audio_transcript.done");
      return;
    }

    if (evt.type === "response.text.done") {
      if (!assistantSeen && !textSeen) return;
      maybeSpeakFromBuffers("text.done");
      return;
    }

    if (evt.type === "error") {
      console.error(`[${new Date().toISOString()}] ❌ OpenAI error:`, JSON.stringify(evt.error));
    }
  });

  openaiWs.on("close", (code) => {
    console.log(`[${new Date().toISOString()}] OpenAI WS closed code=${code}`);
    disarmHangup("openai_ws_close");
    cancelSpeech("openai_ws_close");
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  openaiWs.on("error", (e) => {
    console.error(`[${new Date().toISOString()}] OpenAI WS error:`, e.message);
  });

  twilioWs.on("close", () => {
    console.log(`[${new Date().toISOString()}] Twilio WS closed streamSid=${streamSid}`);
    disarmHangup("twilio_ws_close");
    cancelSpeech("twilio_ws_close");
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  twilioWs.on("error", (e) => {
    console.error(`[${new Date().toISOString()}] Twilio WS error:`, e.message);
    disarmHangup("twilio_ws_error");
    cancelSpeech("twilio_ws_error");
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
});

/* =======================
   START
======================= */
httpServer.listen(PORT, () => {
  console.log(
    `✅ DES inbound live on ${PORT} (Eleven greeting mp3-cache + Stream fallback + OpenAI reply + barge-in + anti-double + hangup-token)`
  );
  warmGreetingCache().catch(() => {});
});
