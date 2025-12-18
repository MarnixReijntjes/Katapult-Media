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
function nowIso() {
  return new Date().toISOString();
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
      `[${nowIso()}] 🔥 Warmed greeting cache bytes=${mp3.length} ms=${Date.now() - t0}`
    );
  } catch (e) {
    console.error(`[${nowIso()}] ❌ Warm greeting failed:`, e.message);
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
        service:
          "des-inbound-eleven-greeting-openai-reply-barge-in-anti-late-response",
        ts: nowIso(),
      });
    }

    if (path === "/twiml" && req.method === "POST") {
      console.log(`[${nowIso()}] TwiML hit method=POST url=/twiml`);

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
        console.log(`[${nowIso()}] TwiML served <Play> + <Stream> ws=${wsUrl}`);
      } else {
        twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" />
  </Connect>
</Response>`;
        console.log(
          `[${nowIso()}] TwiML served <Stream-only> (cache warming) ws=${wsUrl}`
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
  console.log(`[${nowIso()}] WS connected url=${req.url}`);

  // ----- BARGE-IN STATE -----
  let speechToken = 0;
  let currentSpeech = null; // { token, abortController }
  let greetingSpokenViaWs = false;

  // Turn/response correlation (fixes late deltas)
  let turnSeq = 0;
  const responseTurnById = new Map(); // response_id -> turnSeq
  let lastResponseId = null;

  // OpenAI response activity guard (fixes response_cancel_not_active spam)
  let openaiResponseActive = false;

  // ulaw frame packing: 20ms @ 8kHz mono = 160 bytes
  // (keep these for completeness; we also reset them hard on barge-in)
  let ulawBuf = Buffer.alloc(0);

  function cancelSpeech(reason) {
    if (!currentSpeech) return;
    try {
      currentSpeech.abortController.abort();
    } catch {}
    console.log(`[${nowIso()}] Speech cancelled reason=${reason}`);
    currentSpeech = null;
  }

  function twilioClear() {
    if (twilioWs.readyState !== WebSocket.OPEN || !streamSid) return;
    try {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
    } catch {}
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
      console.log(`[${nowIso()}] Hangup mark cleared reason=${reason}`);
    }
  }

  function startHangupCountdown(reason) {
    if (hangupTimer) clearTimeout(hangupTimer);
    hangupTimer = setTimeout(() => {
      console.log(`[${nowIso()}] Hanging up reason=${reason}`);
      try {
        twilioWs.close();
      } catch {}
    }, HANGUP_DELAY_MS);

    console.log(`[${nowIso()}] Hangup armed in ${HANGUP_DELAY_MS}ms reason=${reason}`);
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
      console.log(`[${nowIso()}] Hangup armed via MARK name=${name} reason=${reason}`);

      const FAILSAFE_MS = Math.max(8000, HANGUP_DELAY_MS + 3000);
      hangupFailSafeTimer = setTimeout(() => {
        console.log(
          `[${nowIso()}] Hangup MARK timeout -> fallback name=${name} reason=${reason}`
        );
        cleanupHangupMark("mark_timeout");
        startHangupCountdown("token_seen_fallback");
      }, FAILSAFE_MS);
    } else {
      console.log(`[${nowIso()}] Hangup mark send failed -> fallback reason=${reason}`);
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
    console.log(`[${nowIso()}] Hangup disarmed reason=${reason}`);
  }

  // Audio send stats per speak
  let speakSeq = 0;
  let speakStats = null;

  async function speak(text) {
    const t = (text || "").trim();
    if (!t) return;
    if (!streamSid) return;

    // KILL + REPLACE (no silence when new response arrives)
    if (currentSpeech) {
      cancelSpeech("replace");
      twilioClear();
    }

    const myToken = speechToken;
    const abortController = new AbortController();
    currentSpeech = { token: myToken, abortController };

    const id = `${Date.now()}_${++speakSeq}`;
    speakStats = {
      id,
      sentFrames: 0,
      sentBytes: 0,
      dropNoSid: 0,
      dropNotOpen: 0,
      sendErrors: 0,
      maxSendCbLagMs: 0,
      pendingSendCb: 0,
      startedAt: Date.now(),
      chars: t.length,
      sha1: sha1(t),
      hasToken: t.includes(HANGUP_TOKEN),
      tail: t.slice(Math.max(0, t.length - 90)),
    };

    const t0 = Date.now();
    console.log(
      `[${nowIso()}] SPEAK_START chars=${speakStats.chars} sha1=${speakStats.sha1} hasToken=${speakStats.hasToken} tail="${speakStats.tail}"`
    );

    let ulawLocalBuf = Buffer.alloc(0);
    const frameSize = 160;

    const pushCounted = (chunk) => {
      ulawLocalBuf = Buffer.concat([ulawLocalBuf, chunk]);
      while (ulawLocalBuf.length >= frameSize) {
        const frame = ulawLocalBuf.subarray(0, frameSize);
        ulawLocalBuf = ulawLocalBuf.subarray(frameSize);

        if (!streamSid) {
          speakStats.dropNoSid++;
          continue;
        }
        if (twilioWs.readyState !== WebSocket.OPEN) {
          speakStats.dropNotOpen++;
          continue;
        }

        const payload = JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: frame.toString("base64") },
        });

        const before = Date.now();
        speakStats.pendingSendCb++;
        try {
          twilioWs.send(payload, (err) => {
            const lag = Date.now() - before;
            if (lag > speakStats.maxSendCbLagMs) speakStats.maxSendCbLagMs = lag;
            speakStats.pendingSendCb--;
            if (err) speakStats.sendErrors++;
          });
          speakStats.sentFrames++;
          speakStats.sentBytes += frame.length;
        } catch {
          speakStats.pendingSendCb--;
          speakStats.sendErrors++;
        }
      }
    };

    try {
      await elevenStreamToUlaw(
        t,
        (chunk) => {
          if (speechToken !== myToken) return;
          if (abortController.signal.aborted) return;
          pushCounted(chunk);
        },
        abortController.signal
      );

      if (speechToken !== myToken) return;

      console.log(
        `[${nowIso()}] SPEAK_DONE ms=${Date.now() - t0} chars=${t.length} sha1=${sha1(
          t
        )} hasToken=${t.includes(HANGUP_TOKEN)}`
      );

      if (t.includes(HANGUP_TOKEN)) {
        armHangup("token_seen");
      }
    } catch (e) {
      if (abortController.signal.aborted) return;
      console.error("❌ SPEAK_ERROR:", e.message);
    } finally {
      if (speakStats) {
        console.log(
          `[${nowIso()}] AUDIO_SPEAK_SUMMARY speak=${speakStats.id} sentFrames=${speakStats.sentFrames} sentBytes=${speakStats.sentBytes} dropNoSid=${speakStats.dropNoSid} dropNotOpen=${speakStats.dropNotOpen} sendErrors=${speakStats.sendErrors} maxSendCbLagMs=${speakStats.maxSendCbLagMs} pendingSendCb=${speakStats.pendingSendCb}`
        );
      }
      speakStats = null;

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
    console.log(`[${nowIso()}] OpenAI session.update sent (reply enabled)`);
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
        `[${nowIso()}] Twilio start streamSid=${streamSid} callSid=${msg.start?.callSid}`
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
      console.log(`[${nowIso()}] Twilio MARK received name=${name}`);

      if (pendingHangupMarkName && name === pendingHangupMarkName) {
        console.log(`[${nowIso()}] Hangup MARK matched -> starting hangup countdown`);
        cleanupHangupMark("mark_ack");
        startHangupCountdown("token_seen_mark_ack");
      }
      return;
    }

    if (msg.event === "stop") {
      console.log(`[${nowIso()}] Twilio stop streamSid=${streamSid}`);
      disarmHangup("twilio_stop");
      cancelSpeech("twilio_stop");
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
      return;
    }
  });

  // OpenAI -> speak assistant text
  let assistantBuf = "";
  let assistantSeen = false;

  let textBuf = "";
  let textSeen = false;

  // Anti-double dedupe
  let lastSpokenHash = "";
  let lastSpokenAt = 0;
  const DEDUPE_WINDOW_MS = 5000;

  let spokenForThisResponse = false;

  function resetAssistantBuffers(reason) {
    assistantBuf = "";
    assistantSeen = false;
    textBuf = "";
    textSeen = false;
    spokenForThisResponse = false;
    if (reason) console.log(`[${nowIso()}] ASSISTANT_RESET reason=${reason}`);
  }

  function isEventForCurrentTurn(evt) {
    // If we can detect response_id, enforce turn matching
    const rid =
      evt.response_id ||
      evt.response?.id ||
      evt?.response?.response_id ||
      null;

    if (rid) {
      lastResponseId = rid;
      const t = responseTurnById.get(rid);
      if (t == null) {
        // unknown response id: assume current turn (safe default)
        responseTurnById.set(rid, turnSeq);
        return true;
      }
      return t === turnSeq;
    }

    // If no response id present, we can't hard-filter; allow
    return true;
  }

  function maybeSpeakFromBuffers(trigger) {
    if (spokenForThisResponse) return;

    const combined = (textBuf.trim() || assistantBuf.trim()).trim();
    if (!combined) return;

    const now = Date.now();
    const h = sha1(combined);
    const isDup = h === lastSpokenHash && now - lastSpokenAt < DEDUPE_WINDOW_MS;
    if (isDup) return;

    lastSpokenHash = h;
    lastSpokenAt = now;

    spokenForThisResponse = true;
    speak(combined).catch(() => {});
    console.log(`[${nowIso()}] SPEAK_TRIGGERED via=${trigger}`);
  }

  openaiWs.on("message", async (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }

    if (evt?.type) {
      console.log(`[${nowIso()}] OPENAI_EVT type=${evt.type}`);
    }

    // HARD BARGE-IN
    if (evt.type === "input_audio_buffer.speech_started") {
      console.log(`[${nowIso()}] 🎙️ speech_started (barge-in)`);

      // new turn begins
      turnSeq++;
      responseTurnById.clear();
      lastResponseId = null;

      disarmHangup("barge_in");
      speechToken++;

      // stop any ongoing output immediately
      cancelSpeech("barge_in");
      twilioClear();

      // hard reset buffers (both counted/local + global)
      ulawBuf = Buffer.alloc(0);

      // cancel OpenAI only if active (prevents response_cancel_not_active)
      if (openaiResponseActive) {
        safeOpenAI({ type: "response.cancel" });
      }

      resetAssistantBuffers("barge_in");
      return;
    }

    if (evt.type === "input_audio_buffer.speech_stopped") {
      console.log(`[${nowIso()}] 🎙️ speech_stopped`);
      return;
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      console.log(`[${nowIso()}] 📝 USER SAID: "${evt.transcript}"`);
      return;
    }

    // Response lifecycle flags
    if (evt.type === "response.created") {
      openaiResponseActive = true;

      const rid = evt.response?.id || evt.response_id || null;
      if (rid) {
        responseTurnById.set(rid, turnSeq);
        lastResponseId = rid;
      }
      // new response => allow 1 speak
      spokenForThisResponse = false;
      return;
    }

    // Drop late output from previous turns/responses
    if (
      evt.type?.startsWith("response.") &&
      !isEventForCurrentTurn(evt)
    ) {
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

    if (evt.type === "response.done") {
      openaiResponseActive = false;

      if (!assistantSeen && !textSeen) {
        resetAssistantBuffers("response_done_empty");
        return;
      }

      maybeSpeakFromBuffers("response.done");
      resetAssistantBuffers("response_done");
      return;
    }

    if (evt.type === "error") {
      console.error(`[${nowIso()}] ❌ OpenAI error:`, JSON.stringify(evt.error));
    }
  });

  openaiWs.on("close", (code) => {
    console.log(`[${nowIso()}] OpenAI WS closed code=${code}`);
    openaiResponseActive = false;
    disarmHangup("openai_ws_close");
    cancelSpeech("openai_ws_close");
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  openaiWs.on("error", (e) => {
    console.error(`[${nowIso()}] OpenAI WS error:`, e.message);
  });

  twilioWs.on("close", () => {
    console.log(`[${nowIso()}] Twilio WS closed streamSid=${streamSid}`);
    disarmHangup("twilio_ws_close");
    cancelSpeech("twilio_ws_close");
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  twilioWs.on("error", (e) => {
    console.error(`[${nowIso()}] Twilio WS error:`, e.message);
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
    `✅ DES inbound live on ${PORT} (greeting mp3-cache + Stream fallback + OpenAI realtime + hard barge-in + ignore-late-responses + kill+replace speak + hangup-token)`
  );
  warmGreetingCache().catch(() => {});
});
