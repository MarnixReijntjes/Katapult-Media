import http from 'http';

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DES server up');
});

server.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] ✅ DES server listening on ${PORT}`);
});
