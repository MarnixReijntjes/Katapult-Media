// server.js
import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import http from 'http';
import twilio from 'twilio';
import { spawn } from 'child_process';

dotenv.config();

/* =======================
   BASIC CONFIG
======================= */
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SPEED = parseFloat(process.env.SPEED || '1.0');

// New env vars (preferred)
const INSTRUCTIONS_INBOUND = process.env.INSTRUCTIONS_INBOUND || '';
const INSTRUCTIONS_OUTBOUND = process.env.INSTRUCTIONS_OUTBOUND || process.env.INSTRUCTIONS || ''; // fallback

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY missing');
  process.exit(1);
}
if (!INSTRUCTIONS_OUTBOUND) {
  console.warn('⚠️ INSTRUCTIONS_OUTBOUND missing (or legacy INSTRUCTIONS missing). Outbound may behave poorly.');
}
if (!INSTRUCTIONS_INBOUND) {
  console.warn('⚠️ INSTRUCTIONS_INBOUND missing. Inbound will fall back to OUTBOUND instructions.');
}

/* =======================
   TWILIO
======================= */
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

/* =======================
   PHONE NORMALIZATION (NL)
======================= */
function normalizePhone(raw) {
  if (!raw) return null;

  const cleaned = raw.toString().trim();

  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1).replace(/\D/g, '');
    if (!digits) return null;
    return `+${digits}`;
  }

  const s = cleaned.replace(/\D/g, '');
  if (!s) return null;

  if (s.startsWith('31') && s.length === 11) return `+${s}`;
  if (s.startsWith('06') && s.length === 10) return `+31${s.slice(1)}`;
  if (s.startsWith('6') && s.length === 9) return `+316${s.slice(1)}`;

  return null;
}

/* =======================
   ELEVENLABS → μLAW (stream)
======================= */
async function elevenSpeak(text, onUlaw) {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) throw new Error('ELEVEN_NOT_CONFIGURED');

  const ff = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-ar',
    '8000',
    '-ac',
    '1',
    '-f',
    'mulaw',
    'pipe:1'
  ]);

  ff.stdout.on('data', onUlaw);

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVEN_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify({
      model_id: ELEVEN_MODEL,
      text
    })
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    try {
      ff.stdin.end();
    } catch {}
    throw new Error(`ELEVEN_STREAM_FAILED ${res.status}: ${err}`);
  }

  const { Readable } = await import('stream');
  Readable.fromWeb(res.body).pipe(ff.stdin);

  await new Promise((r) => ff.on('close', r));
}

/* =======================
   HTTP SERVER
======================= */
const httpServer = http.createServer(async (req, res) => {
  // Twilio voice webhook → TwiML with Media Stream
  if (req.url === '/twiml' && req.method === 'POST') {
    const wsUrl = `wss://${req.headers.host}`;
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`);
    return;
  }

  // Outbound test endpoint
  if (req.url.startsWith('/call-test') && req.method === 'GET') {
    try {
      if (!twilioClient) throw new Error('TWILIO_NOT_CONFIGURED');
      if (!TWILIO_FROM) throw new Error('TWILIO_FROM_MISSING');
      if (!PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL_MISSING');

      const url = new URL(req.url, `http://${req.headers.host}`);
      const raw = url.searchParams.get('phone');
      const phone = normalizePhone(raw);

      if (!phone) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid phone number: ${raw}` }));
        return;
      }

      console.log(`📞 /call-test triggered for: ${raw}`);
      console.log(`📞 Triggering call to normalized: ${phone}`);

      const call = await twilioClient.calls.create({
        to: phone,
        from: TWILIO_FROM,
        url: `${PUBLIC_BASE_URL}/twiml`
      });

      console.log(`[${new Date().toISOString()}] Outbound call created: CallSid=${call.sid}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, to: phone, sid: call.sid }));
      return;
    } catch (e) {
      console.error('❌ /call-test error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

/* =======================
   WEBSOCKET SERVER
======================= */
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (twilioWs) => {
  let streamSid = null;

  // Twilio call direction: "inbound" | "outbound-api" | etc.
  let callDirection = null; // unknown until start event
  let twilioStarted = false;

  // OpenAI readiness
  let openaiReady = false;
  let sessionConfigured = false;

  // For outbound: you can choose to wait for user speech to start conversation
  let hasUserSpoken = false;

  // TTS queue (prevents overlap)
  let speaking = false;
  const speakQueue = [];

  // assistant transcript aggregation per response
  let transcriptBuf = '';
  let transcriptSeen = false;

  function safeTwilioSend(obj) {
    if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
    try {
      twilioWs.send(JSON.stringify(obj));
    } catch {}
  }

  // µlaw framing (20ms = 160 bytes @ 8k)
  let ulawBuffer = Buffer.alloc(0);
  function pushAndSendUlaw(chunk) {
    ulawBuffer = Buffer.concat([ulawBuffer, chunk]);
    const frameSize = 160;
    while (ulawBuffer.length >= frameSize) {
      const frame = ulawBuffer.subarray(0, frameSize);
      ulawBuffer = ulawBuffer.subarray(frameSize);
      safeTwilioSend({
        event: 'media',
        streamSid,
        media: { payload: frame.toString('base64') }
      });
    }
  }

  function pumpSpeakQueue() {
    if (speaking) return;
    const next = speakQueue.shift();
    if (!next) return;

    speaking = true;
    elevenSpeak(next, pushAndSendUlaw)
      .catch((e) => console.error('❌ Eleven streaming failed:', e.message))
      .finally(() => {
        speaking = false;
        pumpSpeakQueue();
      });
  }

  function enqueueSpeak(text) {
    const t = (text || '').trim();
    if (!t) return;
    speakQueue.push(t);
    pumpSpeakQueue();
  }

  function chooseInstructions() {
    const dir = (callDirection || '').toLowerCase();
    // Twilio often uses "inbound" for inbound PSTN calls.
    if (dir === 'inbound') return INSTRUCTIONS_INBOUND || INSTRUCTIONS_OUTBOUND;
    return INSTRUCTIONS_OUTBOUND;
  }

  const openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  function safeOpenAISend(obj) {
    if (openaiWs.readyState !== WebSocket.OPEN) return false;
    try {
      openaiWs.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  function maybeConfigureSessionAndMaybeGreet() {
    if (!openaiReady || !twilioStarted) return;
    if (sessionConfigured) return;

    const instructions = chooseInstructions();
    const dir = (callDirection || '').toLowerCase();

    console.log(`[${new Date().toISOString()}] 📞 Direction=${callDirection} -> using ${dir === 'inbound' ? 'INSTRUCTIONS_INBOUND' : 'INSTRUCTIONS_OUTBOUND'}`);

    // Configure session
    safeOpenAISend({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 200,
          create_response: true
        },
        temperature: 0.7,
        max_response_output_tokens: 800,
        speed: SPEED
      }
    });

    sessionConfigured = true;

    // Inbound: Tessa greets first (as receptionist)
    if (dir === 'inbound') {
      safeOpenAISend({
        type: 'response.create',
        response: {
          modalities: ['audio', 'text'],
          instructions: 'Start nu met de opening volgens de instructions. Houd het kort (1 zin).'
        }
      });
    }
    // Outbound: do NOT auto-greet here (lead answers first). We’ll respond after first speech if needed.
  }

  openaiWs.on('open', () => {
    openaiReady = true;
    maybeConfigureSessionAndMaybeGreet();
  });

  twilioWs.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (e) {
      console.error('❌ Twilio JSON parse error:', e.message);
      return;
    }

    if (data.event === 'start') {
      streamSid = data.start.streamSid;
      callDirection = data.start.direction || null; // "inbound" / "outbound-api" etc.
      twilioStarted = true;

      console.log(`[${new Date().toISOString()}] Twilio start streamSid=${streamSid} direction=${callDirection || 'unknown'}`);

      // Now we know direction; configure OpenAI session (if ws is open)
      maybeConfigureSessionAndMaybeGreet();
      return;
    }

    if (data.event === 'media') {
      safeOpenAISend({
        type: 'input_audio_buffer.append',
        audio: data.media.payload
      });
      return;
    }

    if (data.event === 'stop') {
      console.log(`[${new Date().toISOString()}] Twilio stop streamSid=${streamSid}`);
      try {
        if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
      } catch {}
      return;
    }
  });

  openaiWs.on('message', async (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw);
    } catch (e) {
      console.error('❌ OpenAI JSON parse error:', e.message);
      return;
    }

    // For outbound only: optionally wait until user speaks at least once before triggering any manual response.
    // (Auto responses still happen due to create_response=true, but this prevents any manual greet for outbound.)
    if (evt.type === 'input_audio_buffer.speech_stopped') {
      if (!hasUserSpoken) hasUserSpoken = true;
    }

    if (evt.type === 'response.created' || evt.type === 'response.output_item.added') {
      transcriptBuf = '';
      transcriptSeen = false;
      return;
    }

    if (evt.type === 'response.audio_transcript.delta' && typeof evt.delta === 'string') {
      transcriptSeen = true;
      transcriptBuf += evt.delta;
      return;
    }

    if (evt.type === 'response.audio_transcript.done' || evt.type === 'response.done') {
      if (transcriptSeen) {
        const text = transcriptBuf.trim();
        transcriptBuf = '';
        transcriptSeen = false;

        // Speak via ElevenLabs
        if (text) enqueueSpeak(text);
      }
      return;
    }

    if (evt.type === 'error') {
      console.error('❌ OpenAI error:', JSON.stringify(evt.error));
    }
  });

  openaiWs.on('close', (code) => {
    console.log(`[${new Date().toISOString()}] OpenAI WS closed code=${code}`);
    try {
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    } catch {}
  });

  openaiWs.on('error', (e) => {
    console.error('❌ OpenAI WS error:', e.message);
    try {
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    } catch {}
  });

  twilioWs.on('close', () => {
    try {
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    } catch {}
  });

  twilioWs.on('error', () => {
    try {
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    } catch {}
  });
});

/* =======================
   START
======================= */
httpServer.listen(PORT, () => {
  console.log(`✅ Server live on ${PORT}`);
});
