import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import http from 'http';
import twilio from 'twilio';

dotenv.config();

// ---------- Basis config ----------

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const VOICE = process.env.VOICE || 'alloy';
const SPEED = parseFloat(process.env.SPEED || '1.0');
const INSTRUCTIONS =
  process.env.INSTRUCTIONS ||
  'You are Tessa, a helpful and friendly multilingual voice assistant.';

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY ontbreekt');
  process.exit(1);
}

// ---------- Twilio ----------

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ---------- Trello ----------

const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_LIST_ID = process.env.TRELLO_LIST_ID;

console.log('✅ TRELLO DEBUG:', {
  key: TRELLO_KEY ? TRELLO_KEY.slice(0, 4) + '...' + TRELLO_KEY.slice(-4) : null,
  token: TRELLO_TOKEN ? TRELLO_TOKEN.slice(0, 4) + '...' + TRELLO_TOKEN.slice(-4) : null,
  list: TRELLO_LIST_ID
});

// ---------- Call trigger ----------

async function triggerCall(phone) {
  console.log('📞 Triggering call to', phone);
  await twilioClient.calls.create({
    to: phone,
    from: TWILIO_FROM,
    url: `${PUBLIC_BASE_URL}/twiml`
  });
}

// ---------- ✅ TRELLO POLLER ----------

async function pollTrelloLeads() {
  console.log('🔁 Polling Trello list for new leads...');

  try {
    const url = `https://api.trello.com/1/lists/${TRELLO_LIST_ID}/cards?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
    const res = await fetch(url);

    console.log('📡 Trello status:', res.status);

    if (!res.ok) {
      const txt = await res.text();
      console.error('❌ Trello error response:', txt);
      return;
    }

    const cards = await res.json();
    console.log(`📋 ${cards.length} cards found`);

    for (const card of cards) {
      const hasCalled = (card.labels || []).some(l => l.name === 'GEBELD');
      if (hasCalled) continue;

      const match = (card.desc || '').match(/\+?[0-9]{10,15}/);
      if (!match) continue;

      const phone = match[0];
      console.log('📞 Trello trigger:', phone);

      await triggerCall(phone);

      await fetch(
        `https://api.trello.com/1/cards/${card.id}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'GEBELD', color: 'green' })
        }
      );

      console.log('✅ GEBELD gezet op', card.id);
    }
  } catch (e) {
    console.error('❌ Trello poll error:', e.message);
  }
}

setInterval(pollTrelloLeads, 15000);

// ---------- HTTP ----------

const httpServer = http.createServer((req, res) => {
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

// ---------- WS ----------

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', ws => {});

// ---------- START ----------

httpServer.listen(PORT, () => {
  console.log(`✅ Server gestart op ${PORT}`);
});
