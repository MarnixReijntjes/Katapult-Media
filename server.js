import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import http from 'http';
import twilio from 'twilio';
import fetch from 'node-fetch';

dotenv.config();

// ---------- Basis config ----------

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const VOICE = process.env.VOICE || 'alloy';
const SPEED = parseFloat(process.env.SPEED || '1.0');
const INSTRUCTIONS =
  process.env.INSTRUCTIONS ||
  'You are Tessa, a helpful and friendly multilingual voice assistant. You speak Dutch and English naturally.';

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY ontbreekt');
  process.exit(1);
}

// ---------- Twilio config ----------

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn('⚠️ Twilio credentials ontbreken');
}

// ---------- Trello config ----------

const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_LIST_ID = process.env.TRELLO_LIST_ID;

if (!TRELLO_KEY || !TRELLO_TOKEN || !TRELLO_LIST_ID) {
  console.error('❌ Trello ENV vars ontbreken');
}

// ---------- Server stats ----------

const serverStats = {
  startTime: new Date(),
  totalConnections: 0,
  activeConnections: 0,
  totalErrors: 0
};

// ---------- Outbound call helper ----------

async function makeOutboundCall(phone) {
  if (!twilioClient) throw new Error('Twilio client ontbreekt');
  if (!TWILIO_FROM) throw new Error('TWILIO_FROM ontbreekt');
  if (!PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL ontbreekt');

  const twimlUrl = `${PUBLIC_BASE_URL}/twiml`;

  const call = await twilioClient.calls.create({
    to: phone,
    from: TWILIO_FROM,
    url: twimlUrl
  });

  console.log(`✅ Call gestart naar ${phone} (${call.sid})`);
  return call;
}

async function triggerCall(phone) {
  await makeOutboundCall(phone);
}

// ---------- ✅ TRELLO POLLER ----------

async function pollTrelloLeads() {
  try {
    const url = `https://api.trello.com/1/lists/${TRELLO_LIST_ID}/cards?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
    const res = await fetch(url);
    const cards = await res.json();

    for (const card of cards) {
      const hasCalled = card.labels.some(l => l.name === 'GEBELD');
      if (hasCalled) continue;

      const match = card.desc.match(/\+?[0-9]{10,15}/);
      if (!match) continue;

      const phone = match[0];
      console.log(`📞 Trello trigger: ${phone}`);

      await triggerCall(phone);

      await fetch(`https://api.trello.com/1/cards/${card.id}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'GEBELD', color: 'green' })
      });

      console.log(`✅ Label GEBELD gezet op kaart ${card.id}`);
    }
  } catch (e) {
    console.error('❌ Trello poll fout:', e.message);
  }
}

setInterval(pollTrelloLeads, 15000);

// ---------- HTTP server ----------

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  if (req.url === '/twiml' && req.method === 'POST') {
    const websocketUrl = `wss://${req.headers.host}`;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${websocketUrl}" />
  </Connect>
</Response>`;
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml);
    return;
  }

  res.writeHead(404);
  res.end();
});

// ---------- WebSocket server ----------

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log(`✅ Server gestart op poort ${PORT}`);
});

// ---------- Twilio handler ----------

function handleTwilioConnection(twilioWs) {
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
    const sessionConfig = {
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: INSTRUCTIONS,
        voice: VOICE,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        temperature: 0.8,
        speed: SPEED
      }
    };
    openaiWs.send(JSON.stringify(sessionConfig));
  });

  twilioWs.on('message', message => {
    const msg = JSON.parse(message);
    if (msg.event === 'media') {
      openaiWs.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload
        })
      );
    }
  });

  openaiWs.on('message', data => {
    const event = JSON.parse(data);
    if (event.type === 'response.audio.delta') {
      twilioWs.send(
        JSON.stringify({
          event: 'media',
          streamSid: null,
          media: { payload: event.delta }
        })
      );
    }
  });
}

wss.on('connection', handleTwilioConnection);
