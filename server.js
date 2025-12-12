// server.js
import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import http from 'http';
import twilio from 'twilio';

dotenv.config();

/* =======================
   BASIC CONFIG
======================= */
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const INSTRUCTIONS = process.env.INSTRUCTIONS;
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
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

/* =======================
   ELEVENLABS
======================= */
async function elevenTTS(text) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
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
    throw new Error(`ElevenLabs failed ${res.status}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/* =======================
   HTTP SERVER
======================= */
const httpServer = http.createServer((req, res) => {
  if (req.url === '/twiml') {
    const wsUrl = `wss://${req.headers.host}`;
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(`
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>
    `);
    return;
  }

  if (req.url.startsWith('/call-test')) {
    const phone = new URL(req.url, `http://${req.headers.host}`).searchParams.get('phone');
    twilioClient.calls.create({
      to: phone,
      from: TWILIO_FROM,
      url: `${PUBLIC_BASE_URL}/twiml`
    });
    res.end('ok');
    return;
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

  function sendUlaw(buf) {
    twilioWs.send(
      JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: buf.toString('base64') }
      })
    );
  }

  openaiWs.on('open', () => {
    openaiWs.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: INSTRUCTIONS,
          voice: VOICE,
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          turn_detection: { type: 'server_vad', create_response: true },
          speed: SPEED
        }
      })
    );

    // OPENING: TEXT ONLY
    openaiWs.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['text'],
          instructions:
            'Zeg exact de openingszin zoals beschreven, geen extra woorden.'
        }
      })
    );
  });

  twilioWs.on('message', async (msg) => {
    const data = JSON.parse(msg);

    if (data.event === 'start') {
      streamSid = data.start.streamSid;
      return;
    }

    if (data.event === 'media') {
      openaiWs.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: data.media.payload
        })
      );
    }
  });

  openaiWs.on('message', async (raw) => {
    const evt = JSON.parse(raw);

    // === ENIGE NIEUWE LOGICA ===
    if (evt.type === 'response.output_text.done' && !greetingPlayed) {
      greetingPlayed = true;

      const text = evt.text.trim();
      const mp3 = await elevenTTS(text);

      // MP3 → ULaw via ffmpeg (Twilio-compatible)
      const ffmpeg = await import('child_process');
      const proc = ffmpeg.spawn('ffmpeg', [
        '-i', 'pipe:0',
        '-ar', '8000',
        '-ac', '1',
        '-f', 'mulaw',
        'pipe:1'
      ]);

      proc.stdin.write(mp3);
      proc.stdin.end();

      proc.stdout.on('data', (chunk) => {
        sendUlaw(chunk);
      });

      return;
    }

    // === REST BLIJFT OPENAI AUDIO ===
    if (evt.type === 'response.audio.delta') {
      sendUlaw(Buffer.from(evt.delta, 'base64'));
    }
  });
});

httpServer.listen(PORT, () =>
  console.log(`✅ Server live on ${PORT}`)
);
