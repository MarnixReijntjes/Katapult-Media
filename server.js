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
const VOICE = process.env.VOICE || 'alloy';

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

  if (digitsOnly.length === 10 && digitsOnly.startsWith('06')) return `+31${digitsOnly.slice(1)}`;
  if (digitsOnly.length === 11 && digitsOnly.startsWith('31')) return `+${digitsOnly}`;
  if (digitsOnly.length === 9 && digitsOnly.startsWith('6')) return `+316${digitsOnly.slice(1)}`;

  return null;
}

/* =======================
   ELEVENLABS
======================= */
async function elevenTTS(text) {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) throw new Error('ELEVEN_NOT_CONFIGURED');

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`, {
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
    throw new Error(`ELEVEN_TTS_FAILED ${res.status}: ${err}`);
  }

  return Buffer.from(await res.arrayBuffer());
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
      if (!twilioClient) throw new Error('TWILIO_NOT_CONFIGURED');
      if (!TWILIO_FROM) throw new Error('TWILIO_FROM_MISSING');
      if (!PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL_MISSING');

      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const phoneRaw = urlObj.searchParams.get('phone');
      if (!phoneRaw) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing phone parameter' }));
        return;
      }

      const phone = normalizePhone(phoneRaw);
      if (!phone) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid phone format: ${phoneRaw}` }));
        return;
      }

      console.log(`📞 /call-test triggered for: ${phoneRaw}`);
      console.log(`📞 Triggering call to normalized: ${phone}`);

      const call = await twilioClient.calls.create({
        to: phone,
        from: TWILIO_FROM,
        url: `${PUBLIC_BASE_URL}/twiml`
      });

      console.log(`[${new Date().toISOString()}] Outbound call created: CallSid=${call.sid}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', to: phone, callSid: call.sid }));
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
  let greetingPlayed = false;

  const openaiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

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
    const frameSize = 160;
    while (ulawBuffer.length >= frameSize) {
      const frame = ulawBuffer.subarray(0, frameSize);
      ulawBuffer = ulawBuffer.subarray(frameSize);
      sendUlawFrame(frame);
    }
  }

  openaiWs.on('open', () => {
    openaiWs.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          instructions: INSTRUCTIONS,
          voice: VOICE,
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: { type: 'server_vad', create_response: true },
          speed: SPEED
        }
      })
    );

    // OPENING: TEXT ONLY (we will play it via ElevenLabs)
    openaiWs.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['text'],
          instructions: 'Zeg exact de openingszin zoals beschreven, geen extra woorden.'
        }
      })
    );
  });

  // === MINI FIX: guard openaiWs.send while CONNECTING ===
  function safeOpenAISend(obj) {
    if (openaiWs.readyState !== WebSocket.OPEN) return;
    openaiWs.send(JSON.stringify(obj));
  }

  twilioWs.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.event === 'start') {
      streamSid = data.start.streamSid;
      console.log(`[${new Date().toISOString()}] Twilio start streamSid=${streamSid}`);
      return;
    }

    if (data.event === 'media') {
      safeOpenAISend({
        type: 'input_audio_buffer.append',
        audio: data.media.payload
      });
    }

    if (data.event === 'stop') {
      console.log(`[${new Date().toISOString()}] Twilio stop streamSid=${streamSid}`);
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    }
  });

  openaiWs.on('message', async (raw) => {
    const evt = JSON.parse(raw);

    if (evt.type === 'response.output_text.done' && !greetingPlayed) {
      greetingPlayed = true;

      const text = (evt.text || '').trim();
      console.log(`[${new Date().toISOString()}] Opening text from OpenAI (for ElevenLabs): "${text.slice(0, 120)}"`);

      try {
        const mp3 = await elevenTTS(text);

        const proc = spawn('ffmpeg', [
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

        proc.on('error', (e) => {
          console.error('❌ ffmpeg spawn error:', e.message);
        });

        proc.stdout.on('data', (chunk) => {
          pushAndSendUlaw(chunk);
        });

        proc.stderr.on('data', (d) => {
          console.error('❌ ffmpeg stderr:', d.toString());
        });

        proc.stdin.write(mp3);
        proc.stdin.end();

        console.log(`[${new Date().toISOString()}] ✅ Played ElevenLabs opening (mp3 bytes=${mp3.length})`);
      } catch (e) {
        console.error('❌ ElevenLabs opening failed:', e.message);
      }

      return;
    }

    if (evt.type === 'response.audio.delta' && evt.delta) {
      pushAndSendUlaw(Buffer.from(evt.delta, 'base64'));
    }

    if (evt.type === 'error') {
      console.error('❌ OpenAI error:', JSON.stringify(evt.error));
    }
  });

  openaiWs.on('close', (code) => {
    console.log(`[${new Date().toISOString()}] OpenAI WS closed code=${code}`);
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  openaiWs.on('error', (e) => {
    console.error('❌ OpenAI WS error:', e.message);
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });
});

/* =======================
   START
======================= */
httpServer.listen(PORT, () => {
  console.log(`✅ Server live on ${PORT}`);
});
