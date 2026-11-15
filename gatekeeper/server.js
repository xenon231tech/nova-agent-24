// xenon-d62 — Proof Gatekeeper agent for zkVerify Agent Games (Season 01).
// Thin HTTP wrapper around lib/handler.js (the transport-agnostic core).
// Listens on $PORT (default 3000). The same core also runs as a Vercel
// serverless function via api/agent.js.
//
// Env: AGENT_GAMES_HMAC_SECRET (required), PORT, TASKID_MODE, SIGNATURE_FORMAT,
// RAPIDSNARK, STATE_DIR. See lib/handler.js.
'use strict';

const http = require('http');
const { processRequest } = require('./lib/handler');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HMAC_SECRET = process.env.AGENT_GAMES_HMAC_SECRET || '';
const TASKID_MODE = process.env.TASKID_MODE || 'keccak';
const SIGNATURE_FORMAT = process.env.SIGNATURE_FORMAT || 'sha256';

if (!HMAC_SECRET) {
  console.error('FATAL: AGENT_GAMES_HMAC_SECRET is not set. Refusing to start.');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'xenon-d62-gatekeeper', version: 'v1' }));
  }
  if (req.method !== 'POST' || (req.url !== '/agent' && req.url !== '/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not found' }));
  }
  // Diagnostic log: path + signature-header SHAPE only (never the value).
  const sigHdr = req.headers['x-agent-games-signature'] || '';
  console.log(JSON.stringify({ event: 'request', method: req.method, url: req.url,
    sig_present: !!sigHdr, sig_prefix: sigHdr.startsWith('sha256=') ? 'sha256=' : (sigHdr.length === 64 ? 'bare-hex?' : 'other'),
    sig_len: sigHdr.length, ua: (req.headers['user-agent'] || '').slice(0, 60) }));

  const chunks = [];
  req.on('data', (c) => {
    chunks.push(c);
    if (Buffer.concat(chunks).length > 1024 * 1024) { req.destroy(); }
  });
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks);
    const result = await processRequest(rawBody, req.headers['x-agent-games-signature']);
    const headers = { 'Content-Type': 'application/json' };
    if (result.signature) headers['x-agent-games-signature'] = result.signature;
    res.writeHead(result.status, headers);
    res.end(result.body);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`xenon-d62 gatekeeper listening on :${PORT} (taskid=${TASKID_MODE}, sig=${SIGNATURE_FORMAT})`);
});
