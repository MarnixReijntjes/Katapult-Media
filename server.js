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
  const s = raw.replace(/\D/g, '');
  if (s.startsWith('31') && s.length === 11) return `+${s}`;
  if (s.startsWith('06') && s.length === 10) return `+31${s.slice(1)}`;
  if (s.startsWith('6') && s.length === 9) return `+316${s.slice(1)}`;
  return null;
}

/* =======================
   ELEVENLABS → μLAW
======================= */
async function elevenSpeak(text, onUlaw) {
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

  const { Readable } = await import('stream');
  Readable.fromWeb(res.body).pipe(ff.stdin);

  await new Promise(r => ff.on('close', r));
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

  if (req.url.startsWith('/call-test')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const raw = url.searchParams.get('phone');
      const phone = normalizePhone(raw);

      if (!phone) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid phone number' }));
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
      console.error('❌ call-test error', e.message);
      res.writeHead(500);
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
  let streamSid;
  let speaking = false;
  let hasUserSpoken = false;
  let textBuf = Buffer.from('');

  function sendUlaw(frame) {
    if (twilioWs.readyState !== WebSocket.OPEN) return;
    twilioWs.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: frame.toString('base64') }
    }));
  }

  async function speak(text) {
    if (speaking) return;
    speaking = true;
    await elevenSpeak(text, sendUlaw);
    speaking = false;
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

  openaiWs.on('open', () => {
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text'],
        instructions: INSTRUCTIONS,
        input_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          silence_duration_ms: 500,
          create_response: true
        },
        temperature: 0.7,
        speed: SPEED
      }
    }));
  });

  twilioWs.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.event === 'start') {
      streamSid = data.start.streamSid;
      return;
    }

    if (data.event === 'media') {
      openaiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: data.media.payload
      }));
    }
  });

  openaiWs.on('message', async (raw) => {
    const evt = JSON.parse(raw);

    if (evt.type === 'input_audio_buffer.speech_stopped' && !hasUserSpoken) {
      hasUserSpoken = true;
      openaiWs.send(JSON.stringify({
        type: 'response.create',
        response: { modalities: ['text'] }
      }));
      return;
    }

    if (evt.type === 'response.text.delta') {
      textBuf = Buffer.concat([textBuf, Buffer.from(evt.delta)]);
    }

    if (evt.type === 'response.text.done') {
      const text = textBuf.toString().trim();
      textBuf = Buffer.alloc(0);
      if (text) await speak(text);
    }
  });
});

/* =======================
   START
======================= */
httpServer.listen(PORT, () => {
  console.log(`✅ Server live on ${PORT}`);
});
