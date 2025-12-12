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
const INSTRUCTIONS = process.env.INSTRUCTIONS || '';
const SPEED = parseFloat(process.env.SPEED || '1.0');

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY missing');
  process.exit(1);
}

/* =======================
   TWILIO
======================= */
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

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
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-ar', '8000',
    '-ac', '1',
    '-f', 'mulaw',
    'pipe:1'
  ]);

  ff.stdout.on('data', onUlaw);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`,
    {
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
    }
  );

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    try { ff.stdin.end(); } catch {}
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
  if (req.url === '/twiml' && req.method === 'POST') {
    const wsUrl = `wss://${req.headers.host}`;
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(`<?xml version="1.0"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`);
    return;
  }

  if (req.url.startsWith('/call-test') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const raw = url.searchParams.get('phone');
      const phone = normalizePhone(raw);

      if (!phone) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid phone number: ${raw}` }));
        return;
      }

      const call = await twilioClient.calls.create({
        to: phone,
        from: TWILIO_FROM,
        url: `${PUBLIC_BASE_URL}/twiml`
      });

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

  res.writeHead(404);
  res.end();
});

/* =======================
   WEBSOCKET SERVER
======================= */
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (twilioWs) => {
  let streamSid = null;

  // OPENAI WS readiness + small audio buffer until OPEN
  let openaiReady = false;
  const pendingAudio = []; // base64 payload strings
  const MAX_PENDING = 50;  // ~1s-ish

  let hasUserSpoken = false;

  // TTS queue (prevents overlap)
  let speaking = false;
  const speakQueue = [];

  // assistant text buffer
  let textBuf = '';

  function safeTwilioSend(obj) {
    if (twilioWs.readyState !== WebSocket.OPEN) return;
    try {
      twilioWs.send(JSON.stringify(obj));
    } catch (_) {}
  }

  function onUlawChunk(chunk) {
    if (!streamSid) return;
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (buf.length >= 160) {
      const frame = buf.subarray(0, 160);
      buf = buf.subarray(160);
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
    elevenSpeak(next, onUlawChunk)
      .catch((e) => console.error('❌ Eleven error:', e.message))
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

  // Early speak chunk extraction
  function extractSpeakableChunkFromBuffer() {
    const s = textBuf;
    if (!s) return null;

    const candidates = ['.', '?', '!', '\n'];
    let last = -1;
    for (const c of candidates) {
      const i = s.lastIndexOf(c);
      if (i > last) last = i;
    }

    if (last >= 40) {
      const chunk = s.slice(0, last + 1).trim();
      textBuf = s.slice(last + 1);
      return chunk;
    }

    if (s.length >= 140) {
      const cut = s.lastIndexOf(' ', 140);
      if (cut >= 60) {
        const chunk = s.slice(0, cut).trim();
        textBuf = s.slice(cut + 1);
        return chunk;
      }
    }

    return null;
  }

  const openaiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  function safeOpenAISend(obj) {
    if (openaiWs.readyState !== WebSocket.OPEN) return false;
    try {
      openaiWs.send(JSON.stringify(obj));
      return true;
    } catch (_) {
      return false;
    }
  }

  openaiWs.on('open', () => {
    openaiReady = true;

    safeOpenAISend({
      type: 'session.update',
      session: {
        modalities: ['text'],
        instructions: INSTRUCTIONS,
        input_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          // MINI-STAP: 500 -> 200 (sneller turn detect)
          silence_duration_ms: 200,
          create_response: true
        },
        temperature: 0.7,
        speed: SPEED
      }
    });

    while (pendingAudio.length) {
      const payload = pendingAudio.shift();
      safeOpenAISend({ type: 'input_audio_buffer.append', audio: payload });
    }
  });

  openaiWs.on('close', () => {
    openaiReady = false;
    try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); } catch {}
  });

  openaiWs.on('error', (e) => {
    openaiReady = false;
    console.error('❌ OpenAI WS error:', e.message);
    try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); } catch {}
  });

  twilioWs.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        console.log(`[${new Date().toISOString()}] Twilio start streamSid=${streamSid}`);
        return;
      }

      if (data.event === 'media') {
        const payload = data.media?.payload;
        if (!payload) return;

        if (!openaiReady || openaiWs.readyState !== WebSocket.OPEN) {
          pendingAudio.push(payload);
          if (pendingAudio.length > MAX_PENDING) pendingAudio.shift();
          return;
        }

        safeOpenAISend({ type: 'input_audio_buffer.append', audio: payload });
        return;
      }

      if (data.event === 'stop') {
        console.log(`[${new Date().toISOString()}] Twilio stop streamSid=${streamSid}`);
        try { if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
        return;
      }
    } catch (e) {
      console.error('❌ Twilio message parse error:', e.message);
    }
  });

  openaiWs.on('message', async (raw) => {
    try {
      const evt = JSON.parse(raw);

      // You speak first: create response only after first speech_stopped
      if (evt.type === 'input_audio_buffer.speech_stopped' && !hasUserSpoken) {
        hasUserSpoken = true;
        safeOpenAISend({ type: 'response.create', response: { modalities: ['text'] } });
        return;
      }

      if (
        (evt.type === 'response.text.delta' || evt.type === 'response.output_text.delta') &&
        typeof evt.delta === 'string'
      ) {
        textBuf += evt.delta;

        let chunk;
        while ((chunk = extractSpeakableChunkFromBuffer())) {
          enqueueSpeak(chunk);
          if (speakQueue.length >= 2) break;
        }
        return;
      }

      if (evt.type === 'response.text.done' || evt.type === 'response.output_text.done') {
        const rest = (textBuf || '').trim();
        textBuf = '';
        if (rest) enqueueSpeak(rest);
        return;
      }

      if (evt.type === 'error') {
        console.error('❌ OpenAI error event:', JSON.stringify(evt.error));
      }
    } catch (e) {
      console.error('❌ OpenAI message parse error:', e.message);
    }
  });

  twilioWs.on('close', () => {
    try { if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
  });

  twilioWs.on('error', () => {
    try { if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
  });
});

/* =======================
   START
======================= */
httpServer.listen(PORT, () => {
  console.log(`✅ Server live on ${PORT}`);
});
