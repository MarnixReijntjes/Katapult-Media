import http from 'http';

const PORT = process.env.PORT || 10000;

// Zet dit in Render env als je wil (of hardcode de tekst hieronder)
const INBOUND_GREETING = process.env.INBOUND_GREETING || 'Hoi, met Tessa van DES.';

const server = http.createServer((req, res) => {
  // health
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    return;
  }

  // Twilio Voice webhook (inbound) -> TwiML
  if (req.method === 'POST' && req.url === '/twiml') {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="nl-NL">${escapeXml(INBOUND_GREETING)}</Say>
</Response>`;

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml);
    console.log(`[${new Date().toISOString()}] TwiML served /twiml greeting="${INBOUND_GREETING}"`);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] ✅ DES server listening on ${PORT}`);
});

// minimal XML escape so TwiML doesn't break
function escapeXml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
