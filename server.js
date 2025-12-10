console.log('🚀 SERVER BOOTED – BUILD 2025-01-TRELLO-CALL');

import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import http from 'http';
import twilio from 'twilio';

dotenv.config();

// ---------- BASIS ----------

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const VOICE = process.env.VOICE || 'alloy';
const SPEED = parseFloat(process.env.SPEED || '1.0');
const INSTRUCTIONS =
  process.env.INSTRUCTIONS ||
  'You are Tessa, a multilingual voice assistant.';

console.log('✅ ENV CHECK:', {
  OPENAI: !!OPENAI_API_KEY,
  TWILIO_SID: !!process.env.TWILIO_ACCOUNT_SID,
  TRELLO_KEY: !!process.env.TRELLO_KEY,
  LIST: process.env.TRELLO_LIST_ID
});

// ---------- TWILIO ----------

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ---------- TRELLO ----------

const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_LIST_ID = process.env.TRELLO_LIST_ID;

// ---------- NORMALIZE ----------

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');

  if (digits.length === 10 && digits.startsWith('06')) return `+31${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith('31')) return `+${digits}`;
  if (digits.length === 9 && digits.startsWith('6')) return `+316${digits.slice(1)}`;
  if (digits.length > 10) return `+${digits}`;

  return null;
}

// ---------- CALL ----------

async function makeOutboundCall(phone) {
  console.log(`📞 CALLING ${phone}`);
  return twilioClient.calls.create({
    to: phone,
    from: TWILIO_FROM,
    url: `${PUBLIC_BASE_URL}/twiml`
  });
}

async function triggerCall(raw) {
  const phone = normalizePhone(raw);
  if (!phone) throw new Error('Invalid phone');
  await makeOutboundCall(phone);
}

// ---------- POLLER ----------

async function pollTrelloLeads() {
  console.log('🔁 POLLING TRELLO...');

  try {
    const url = `https://api.trello.com/1/lists/${TRELLO_LIST_ID}/cards?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
    const res = await fetch(url);

    console.log('📡 STATUS:', res.status);

    if (!res.ok) {
      console.error(await res.text());
      return;
    }

    const cards = await res.json();
    console.log(`📋 ${cards.length} cards`);

    for (const card of cards) {
      if ((card.labels || []).some(l => l.name === 'GEBELD')) continue;

      const match = (card.desc || '').match(/(\+?[0-9][0-9()\-\s]{7,20})/);
      if (!match) continue;

      try {
        await triggerCall(match[0]);

        const labelUrl = `https://api.trello.com/1/cards/${card.id}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
        await fetch(labelUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'GEBELD', color: 'green' })
        });

        console.log(`✅ GEBELD → ${card.id}`);
      } catch (err) {
        console.error(`❌ CALL ERROR:`, err.message);
      }
    }
  } catch (e) {
    console.error('❌ POLLER FAIL:', e.message);
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
    const wsUrl = `wss://${req.headers.host}`;
    const twiml = `<Response><Connect><Stream url="${wsUrl}"/></Connect></Response>`;
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml);
    return;
  }

  res.writeHead(404);
  res.end();
});

// ---------- WS ----------

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', () => console.log('☎️ TWILIO WS CONNECTED'));

// ---------- START ----------

httpServer.listen(PORT, () => {
  console.log(`✅ SERVER LISTENING ON ${PORT}`);
});
