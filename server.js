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
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

/* =======================
   PHONE NORMALIZATION (NL)
======================= */
function normalizePhone(raw) {
  if (!raw) return null;

  let cleaned = raw.toString().trim();

  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1).replace(/\D/g, '');
    if (!digits) return null;
    return `+${digits}`;
  }

  const digitsOnly = cleaned.replace(/\D/g, '');
  if (!digitsOnly) return null;

  if (digitsOnly.length === 10 && digitsOnly.startsWith('06'))
    return `+31${digitsOnly.slice(1)}`;
  if (digitsOnly.length === 11 && digitsOnly.startsWith('31'))
    return `+${digitsOnly}`;
  if (digitsOnly.length === 9 && digitsOnly.startsWith('6'))
    return `+316${digitsOnly.slice(1)}`;

  return null;
}

/* =======================
   ELEVENLABS (STREAMING)
======================= */
async function elevenTTSStreamToUlaw(text, pushUlaw) {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID)
    throw new Error('ELEVEN_NOT_CONFIGURED');

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

  ff.stdout.on('data', (chunk) => pushUlaw(chunk));

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
    try {
      ff.stdin.end();
    } catch {}
    throw new Error(`ELEVEN_STREAM_FAILED ${res.status}: ${err}`);
  }

  try {
    const { Readable } = await import('stream');
    const nodeStream = Readable.fromWeb(res.body);
    nodeStream.on('data', (d) => ff.stdin.write(d));
    nodeStream.on('end', () => ff.stdin.end());
    nodeStream.on('error', () => ff.stdin.end());
  } catch {
    const buf = Buffer.from(await res.arrayBuffer());
    ff.stdin.write(buf);
    ff.stdin.end();
  }

  await new Promise((resolve) => ff.on('close', resolve));
}

/* =======================
   HTTP SERVER
======================= */
const httpServer = http.createServer(async (req, res) => {
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

  if (req.url.startsWith('/call-test') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const phoneRaw = urlObj.searchParams.get('phone');
      const phone = normalizePhone(phoneRaw);

      const call = await twilioClient.calls.create({
        to: phone,
        from: TWILIO_FROM,
        url: `${PUBLIC_BASE_URL}/twiml`
      });

      res.end(JSON.stringify({ callSid: call.sid }));
      return;
    } catch (e) {
      res.writeHead(500);
      res.end(e.message);
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
  let textBuf = '';
  let textSeen = false;
  let speaking = false;

  let farewellPending = false;
  let hangupTimer = null;
  let lastUserSpeechAt = 0;

  function clearHangupTimer() {
    if (hangupTimer) clearTimeout(hangupTimer);
    hangupTimer = null;
  }

  function isFinalFarewell(t) {
    return /(?:tot ziens|fijne dag(?: verder)?|doei|dag hoor)[.!?]*$/i.test(
      (t || '').trim()
    );
  }

  function armHangupAfterSilence(ms) {
    clearHangupTimer();
    hangupTimer = setTimeout(() => {
      if (farewellPending && Date.now() - lastUserSpeechAt >= ms) {
        twilioWs.close();
      }
    }, ms);
  }

  function sendUlawFrame(frame) {
    if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
    twilioWs.send(
      JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: frame.toString('base64') }
      })
    );
  }

  let ulawBuffer = Buffer.alloc(0);
  function pushAndSendUlaw(chunk) {
    ulawBuffer = Buffer.concat([ulawBuffer, chunk]);
    while (ulawBuffer.length >= 160) {
      sendUlawFrame(ulawBuffer.subarray(0, 160));
      ulawBuffer = ulawBuffer.subarray(160);
    }
  }

  async function speakElevenStreaming(text) {
    if (speaking) return;
    speaking = true;
    await elevenTTSStreamToUlaw(text, pushAndSendUlaw);
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

  function safeOpenAISend(obj) {
    if (openaiWs.readyState === WebSocket.OPEN)
      openaiWs.send(JSON.stringify(obj));
  }

  openaiWs.on('open', () => {
    safeOpenAISend({
      type: 'session.update',
      session: {
        modalities: ['text'],
        instructions: INSTRUCTIONS,
        input_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          silence_duration_ms: 500,
          create_response: true
        },
        temperature: 0.7,
        max_response_output_tokens: 800,
        speed: SPEED
      }
    });

    safeOpenAISend({
      type: 'response.create',
      response: {
        modalities: ['text'],
        instructions: 'Zeg exact de openingszin zoals beschreven.'
      }
    });
  });

  twilioWs.on('message', (msg) => {
    const data = JSON.parse(msg);
    if (data.event === 'start') streamSid = data.start.streamSid;
    if (data.event === 'media')
      safeOpenAISend({
        type: 'input_audio_buffer.append',
        audio: data.media.payload
      });
  });

  openaiWs.on('message', async (raw) => {
    const evt = JSON.parse(raw);

    if (evt.type === 'input_audio_buffer.speech_started') {
      lastUserSpeechAt = Date.now();
      farewellPending = false;
      clearHangupTimer();
    }

    if (evt.type === 'response.output_text.delta') {
      textSeen = true;
      textBuf += evt.delta;
    }

    if (evt.type === 'response.done') {
      if (!textSeen) return;
      const text = textBuf.trim();
      textBuf = '';
      textSeen = false;

      const shouldHangup = isFinalFarewell(text);
      await speakElevenStreaming(text);

      if (shouldHangup) {
        farewellPending = true;
        armHangupAfterSilence(3000);
      }
    }
  });
});

/* =======================
   START
======================= */
httpServer.listen(PORT, () => {
  console.log(`✅ Server live on ${PORT}`);
});
