// Vercel serverless function for the xenon-d62 Proof Gatekeeper.
// Serves POST /api/agent (the Agent Games endpoint). The platform POSTs task
// envelopes here; the shared core in ../lib/handler.js verifies the HMAC,
// decides, generates the Groth16 proof and returns a signed response.
//
// Vercel Node functions use the plain Node http.ServerResponse API
// (writeHead / end) — NOT Express-style res.status().json().
//
// bodyParser must stay off: the HMAC is verified over the RAW request body.
'use strict';

const { processRequest } = require('../lib/handler');

function send(res, status, body, signature) {
  const headers = { 'Content-Type': 'application/json' };
  if (signature) headers['x-agent-games-signature'] = signature;
  res.writeHead(status, headers);
  res.end(body);
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return send(res, 200, JSON.stringify({ ok: true, service: 'xenon-d62-gatekeeper', version: 'v1' }), null);
  }
  if (req.method !== 'POST') {
    return send(res, 404, JSON.stringify({ error: 'not found' }), null);
  }
  const chunks = [];
  try {
    for await (const chunk of req) {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 1024 * 1024) {
        return send(res, 413, JSON.stringify({ error: 'body too large' }), null);
      }
    }
  } catch (e) {
    return send(res, 400, JSON.stringify({ error: 'unreadable body' }), null);
  }
  const rawBody = Buffer.concat(chunks);
  const result = await processRequest(rawBody, req.headers['x-agent-games-signature']);
  return send(res, result.status, result.body, result.signature);
};

module.exports.config = { api: { bodyParser: false } };
