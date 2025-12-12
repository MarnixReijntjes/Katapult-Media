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

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

/* =======================
   ELEVENLABS
======================= */
async function elevenTTSStreamToUlaw(text, pushUlaw) {
  const ff = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-ar', '8000',
    '-ac', '1',
    '-f', 'mulaw',
    'pipe:1'
  ]);

  ff.stdout.on('data', pushUlaw);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg'
      },
      body: JSON.stringify({ model_id: ELEVEN_MODEL, text })
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
    res.end(`
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`);
    return;
  }

  if (req.url.startsWith('/call-test')) {
    const phone = new URL(req.url, `http://${req.headers.host}`).searchParams.get('phone');
    const call = await twilioClient.calls.create({
      to: phone,
      from: TWILIO_FROM,
      url: `${PUBLIC_BASE_URL}/twiml`
    });
    res.end(JSON.stringify({ ok: true, sid: call.sid }));
    return;
  }

  res.writeHead(404).end();
});

/* =======================
   WEBSOCKET SERVER
======================= */
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (twilioWs) => {
  let streamSid;
  let speaking = false;
  let hasUserSpoken = false;
  let textBuf = '';

  function sendUlaw(frame) {
    twilioWs.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: frame.toString('base64') }
    }));
  }

  async function speak(text) {
    if (speaking) return;
    speaking = true;
    await elevenTTSStreamToUlaw(text, sendUlaw);
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

    if (evt.type === 'input_audio_buffer.speech_stopped') {
      if (!hasUserSpoken) {
        hasUserSpoken = true;
        openaiWs.send(JSON.stringify({
          type: 'response.create',
          response: { modalities: ['text'] }
        }));
      }
    }

    if (evt.type === 'response.text.delta') {
      textBuf += evt.delta;
    }

    if (evt.type === 'response.text.done') {
      await speak(textBuf);
      textBuf = '';
    }
  });
});

/* =======================
   START
======================= */
httpServer.listen(PORT, () => {
  console.log(`✅ Server live on ${PORT}`);
});
