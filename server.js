import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import http from 'http';
import twilio from 'twilio';

dotenv.config();

// ======= FORCED GLOBAL FETCH (Render-safe) =======
let fetch;
try {
  fetch = global.fetch || (await import('node-fetch')).default;
  console.log('✅ fetch loaded');
} catch (e) {
  console.error('❌ fetch NOT available:', e.message);
}

// ---------- Basis config ----------

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VOICE = process.env.VOICE || 'alloy';
const SPEED = parseFloat(process.env.SPEED || '1.0');
const INSTRUCTIONS = process.env.INSTRUCTIONS || 'Je bent Tessa.';

// ---------- Twilio ----------
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

let twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ---------- Trello ----------
const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_LIST_ID = process.env.TRELLO_LIST_ID;

console.log('✅ ENV CHECK:', {
  hasKey: !!TRELLO_KEY,
  hasToken: !!TRELLO_TOKEN,
  hasList: !!TRELLO_LIST_ID
});

// ---------- Outbound call ----------

async function triggerCall(phone) {
  console.log('📞 Triggering call to', phone);
  await twilioClient.calls.create({
    to: phone,
    from: TWILIO_FROM,
    url: `${PUBLIC_BASE_URL}/twiml`
  });
}

// ---------- ✅ TRELLO POLLER MET HARDE LOGS ----------

async function pollTrelloLeads() {
  console.log('🔁 Polling Trello...');

  try {
    const url = `https://api.trello.com/1/lists/${TRELLO_LIST_ID}/cards?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
    const res = await fetch(url);

    console.log('📡 Trello status:', res.status);

    const cards = await res.json();
    console.log(`📋 ${cards.length} kaarten gevonden`);

    for (const card of cards) {
      const hasCalled = card.labels.some(l => l.name === 'GEBELD');
      if (hasCalled) continue;

      const match = card.desc.match(/\+?[0-9]{10,15}/);
      if (!match) continue;

      const phone = match[0];
      console.log('📞 Trello trigger:', phone);

      await triggerCall(phone);

      await fetch(`https://api.trello.com/1/cards/${card.id}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'GEBELD', color: 'green' })
      });

      console.log('✅ GEBELD gezet op', card.id);
    }
  } catch (e) {
    console.error('❌ POLLER ERROR:', e.message);
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
