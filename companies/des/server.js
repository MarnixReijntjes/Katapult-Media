// companies/des/server.js
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import { spawn } from 'child_process';

dotenv.config();

/* =======================
   CONFIG
======================= */
const PORT = process.env.PORT || 10000;
const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
const GREETING_TEXT = 'Hoi, met Tessa van DES.';

if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
  console.error('❌ ElevenLabs vars missing');
  process.exit(1);
}

/* =======================
   ELEVEN → μLAW
======================= */
async function elevenToUlaw(text, onChunk) {
  const ff = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-ar', '8000',
    '-ac', '1',
    '-f', 'mulaw',
    'pipe:1'
  ]);

  ff.stdout.on('data', onChunk);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg'
      },
      body: JSON.stringify({ text, model_id: ELEVEN_MODEL })
    }
  );

  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    ff.stdin.write(Buffer.from(value));
  }

  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
}

/* =======================
   HTTP + TWIML
======================= */
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/twiml') {
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>https://${req.headers.host}/greeting</Play>
  <Connect>
    <Stream url="wss://${req.headers.host}/ws" />
  </Connect>
</Response>`);
    return;
  }

  if (req.url === '/greeting') {
    res.writeHead(200, { 'Content-Type': 'audio/mulaw' });
    await elevenToUlaw(GREETING_TEXT, chunk => res.write(chunk));
    res.end();
    return;
  }

  res.writeHead(404);
  res.end();
});

/* =======================
   WEBSOCKET (Twilio Media)
======================= */
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  let streamSid;

  ws.on('message', msg => {
    const data = JSON.parse(msg);
    if (data.event === 'start') {
      streamSid = data.start.streamSid;
      console.log('📞 inbound stream', streamSid);
    }
    if (data.event === 'stop') {
      ws.close();
    }
  });
});

/* =======================
   START
======================= */
server.listen(PORT, () => {
  console.log(`✅ DES inbound live on ${PORT}`);
});
