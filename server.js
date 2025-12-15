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

const INSTRUCTIONS_OUTBOUND = process.env.INSTRUCTIONS_OUTBOUND || process.env.INSTRUCTIONS || '';
const OUTBOUND_OPENING = process.env.OUTBOUND_OPENING || 'Hoi, met Tessa van Move2Go Solutions.';
const OUTBOUND_OPENING_DELAY_MS = parseInt(process.env.OUTBOUND_OPENING_DELAY_MS || '700', 10);

// Outbound guard: prevent OpenAI from re-introducing
const OUTBOUND_GUARD = `
BELANGRIJK (OUTBOUND):
- Dit is OUTBOUND: jij belt de klant. Zeg NOOIT "leuk dat u belt".
- Je hebt je al voorgesteld via een vooraf afgespeelde openingszin.
- Herhaal NIET je naam, bedrijf, begroeting ("hoi", "goedemiddag") of openingszin.
- Begin direct met de inhoudelijke eerste vraag, zonder extra introductie.
- Zeg geen "met Tessa" / "ik bel namens" / "goedemiddag" / "hoe kan ik helpen" als opening.
`;

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY missing');
  process.exit(1);
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
async function elevenSpeakAbortable(text, onUlaw, signal) {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) throw new Error('ELEVEN_NOT_CONFIGURED');
  if (signal?.aborted) throw new Error('ABORTED');

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

  const killAll = () => {
    try { ff.stdin.end(); } catch {}
    try { ff.kill('SIGKILL'); } catch {}
  };

  if (signal) signal.addEventListener('abort', () => killAll(), { once: true });
  ff.stdout.on('data', onUlaw);

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream?optimize_streaming_latency=4`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVEN_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify({ model_id: ELEVEN_MODEL, text }),
    signal
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    killAll();
    throw new Error(`ELEVEN_STREAM_FAILED ${res.status}: ${err}`);
  }

  const { Readable } = await import('stream');
  const src = Readable.fromWeb(res.body);

  if (signal) {
    signal.addEventListener(
      'abort',
      () => {
        try { src.destroy(); } catch {}
        killAll();
      },
      { once: true }
    );
  }

  src.pipe(ff.stdin);

  await new Promise((r) => {
    ff.on('close', r);
    ff.on('error', r);
  });

  if (signal?.aborted) throw new Error('ABORTED');
}

/* =======================
   OUTBOUND CALL
======================= */
async function makeOutboundCall(phoneE164) {
  if (!twilioClient) throw new Error('TWILIO_NOT_CONFIGURED');
  if (!TWILIO_FROM) throw new Error('TWILIO_FROM_MISSING');
  if (!PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL_MISSING');

  const call = await twilioClient.calls.create({
    to: phoneE164,
    from: TWILIO_FROM,
    url: `${PUBLIC_BASE_URL}/twiml`
  });

  console.log(
    `[${new Date().toISOString()}] Outbound call created CallSid=${call.sid} to=${phoneE164}`
  );
  return call;
}

/* =======================
   HTTP SERVER
======================= */
const httpServer = http.createServer(async (req, res) => {
  if (req.url && req.url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    return;
  }

  if (req.url && req.url.startsWith('/twiml') && (req.method === 'POST' || req.method === 'GET')) {
    console.log(`[${new Date().toISOString()}] TwiML hit method=${req.method} url=${req.url}`);
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

  if (req.url && req.url.startsWith('/call-test') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const raw = url.searchParams.get('phone');
      const phone = normalizePhone(raw);

      if (!raw || !phone) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid phone number: ${raw}` }));
        return;
      }

      console.log(`[${new Date().toISOString()}] /call-test raw=${raw} normalized=${phone}`);
      const call = await makeOutboundCall(phone);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, to: phone, sid: call.sid }));
      return;
    } catch (e) {
      console.error(`/call-test error: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

/* =======================
   WEBSOCKET SERVER (Twilio Media Stream)
======================= */
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (twilioWs) => {
  let streamSid = null;
  let greeted = false;

  let callActive = true;
  let currentAbort = null;

  // NEW: only speak OpenAI after user has spoken at least once
  let userHasSpoken = false;

  // TTS queue
  let speaking = false;
  const speakQueue = [];

  // OpenAI transcript aggregation
  let transcriptBuf = '';
  let transcriptSeen = false;

  function safeTwilioSend(obj) {
    if (!callActive) return;
    if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
    try { twilioWs.send(JSON.stringify(obj)); } catch {}
  }

  let ulawBuffer = Buffer.alloc(0);
  function pushAndSendUlaw(chunk) {
    if (!callActive) return;
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

  function cancelAllSpeech(reason) {
    callActive = false;
    speakQueue.length = 0;
    if (currentAbort) {
      try { currentAbort.abort(); } catch {}
      currentAbort = null;
    }
    console.log(`[${new Date().toISOString()}] Speech cancelled reason=${reason}`);
  }

  async function pumpSpeakQueue() {
    if (speaking) return;
    if (!callActive) return;
    if (twilioWs.readyState !== WebSocket.OPEN) return;

    const next = speakQueue.shift();
    if (!next) return;

    speaking = true;
    currentAbort = new AbortController();
    const started = Date.now();
    console.log(`[${new Date().toISOString()}] SPEAK_START text="${next.slice(0, 80)}"`);

    try {
      await elevenSpeakAbortable(next, pushAndSendUlaw, currentAbort.signal);
      const ms = Date.now() - started;
      console.log(`[${new Date().toISOString()}] Eleven finished ms=${ms} text="${next.slice(0, 80)}"`);
    } catch (e) {
      if (String(e.message).includes('ABORTED') || currentAbort?.signal?.aborted) {
        console.log(`[${new Date().toISOString()}] Eleven aborted`);
      } else {
        console.error(`Eleven error: ${e.message}`);
      }
    } finally {
      speaking = false;
      currentAbort = null;
      if (callActive) pumpSpeakQueue();
    }
  }

  function enqueueSpeak(text) {
    const t = (text || '').trim();
    if (!t) return;
    if (!callActive) return;
    speakQueue.push(t);
    pumpSpeakQueue();
  }

  // OpenAI Realtime WS
  const openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  function safeOpenAISend(obj) {
    if (openaiWs.readyState !== WebSocket.OPEN) return;
    try { openaiWs.send(JSON.stringify(obj)); } catch {}
  }

  openaiWs.on('open', () => {
    const INSTRUCTIONS_EFFECTIVE = `${OUTBOUND_GUARD}\n\n${INSTRUCTIONS_OUTBOUND}`.trim();

    safeOpenAISend({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: INSTRUCTIONS_EFFECTIVE,
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

    console.log(`[${new Date().toISOString()}] OpenAI session.update sent (OUTBOUND_GUARD enabled)`);
  });

  twilioWs.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    if (data.event === 'start') {
      streamSid = data.start.streamSid;
      console.log(`[${new Date().toISOString()}] Twilio start streamSid=${streamSid}`);

      if (!greeted) {
        greeted = true;
        setTimeout(() => {
          if (!callActive) return;
          if (twilioWs.readyState !== WebSocket.OPEN) return;
          enqueueSpeak(OUTBOUND_OPENING);
        }, OUTBOUND_OPENING_DELAY_MS);
      }
      return;
    }

    if (data.event === 'media') {
      if (!callActive) return;
      safeOpenAISend({ type: 'input_audio_buffer.append', audio: data.media.payload });
      return;
    }

    if (data.event === 'stop') {
      console.log(`[${new Date().toISOString()}] Twilio stop streamSid=${streamSid}`);
      cancelAllSpeech('twilio_stop');
      try { if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
      return;
    }
  });

  openaiWs.on('message', async (raw) => {
    let evt;
    try { evt = JSON.parse(raw); } catch { return; }
    if (!callActive) return;

    // NEW: mark that the user actually spoke
    if (evt.type === 'input_audio_buffer.speech_started') {
      if (!userHasSpoken) {
        userHasSpoken = true;
        console.log(`[${new Date().toISOString()}] userHasSpoken=true (OpenAI speech_started)`);
      }
      return;
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

    // IMPORTANT: only speak on response.done (single trigger)
    if (evt.type === 'response.done') {
      const text = transcriptBuf.trim();
      transcriptBuf = '';
      transcriptSeen = false;

      if (!text) return;

      if (!userHasSpoken) {
        console.log(
          `[${new Date().toISOString()}] Skipping OpenAI speech (userHasSpoken=false) text="${text.slice(0, 80)}"`
        );
        return;
      }

      enqueueSpeak(text);
      return;
    }

    if (evt.type === 'error') {
      console.error(`OpenAI error: ${JSON.stringify(evt.error)}`);
    }
  });

  openaiWs.on('close', (code) => {
    console.log(`[${new Date().toISOString()}] OpenAI WS closed code=${code}`);
    try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); } catch {}
  });

  openaiWs.on('error', (e) => {
    console.error(`OpenAI WS error: ${e.message}`);
    try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); } catch {}
  });

  twilioWs.on('close', () => cancelAllSpeech('twilio_ws_close'));
  twilioWs.on('error', () => cancelAllSpeech('twilio_ws_error'));
});

/* =======================
   START
======================= */
httpServer.listen(PORT, () => {
  console.log(`Server live on ${PORT}`);
});
