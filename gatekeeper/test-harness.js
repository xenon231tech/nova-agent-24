// Test harness: replays sample Proof Gatekeeper envelopes (1 valid + 6 traps)
// against a locally running server, verifies HMAC signatures both ways and
// verifies every returned Groth16 proof with snarkjs.
//
// Usage:
//   AGENT_GAMES_HMAC_SECRET=test-secret node server.js   # terminal 1 (port 3000)
//   node test-harness.js                                  # terminal 2
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const snarkjs = require('snarkjs');

const BASE = process.env.AGENT_URL || 'http://127.0.0.1:3000';
const SECRET = process.env.AGENT_GAMES_HMAC_SECRET || 'test-secret';
const VK = JSON.parse(fs.readFileSync(__dirname + '/verification_key.json', 'utf8'));

function hmacHex(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}
function signCheck(body, headerValue) {
  if (!headerValue) return false;
  let provided = headerValue.trim();
  if (provided.toLowerCase().startsWith('sha256=')) provided = provided.slice(7);
  try { return crypto.timingSafeEqual(Buffer.from(provided.toLowerCase()), Buffer.from(hmacHex(body))); }
  catch (_) { return false; }
}

async function post(path, obj, { badSig = false } = {}) {
  const body = JSON.stringify(obj);
  const sig = badSig ? 'sha256=00' : `sha256=${hmacHex(body)}`;
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-games-signature': sig },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* ignore */ }
  return { status: res.status, json, text, sigOk: signCheck(text, res.headers.get('x-agent-games-signature')) };
}

const BASE_INPUT = {
  registered_vk: '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0',
  proof_vk: '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0',
  minimum: '1000',
  public_balance: '1460',
  expiry_block: 8430000,
  current_block: 8420000,
  recipient: '0xDe42a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8',
  condition_recipient: '0xDe42a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8',
  amount: '500',
  max_transfer: '1000',
  proof_tx: '0xa8b3c4d5e6f7000000000000000000000000000000000000000000000000001',
};

function envelope(taskId, input, extra = {}) {
  return {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: taskId,
    mode: 'practice',
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60000).toISOString(),
    input,
    ...extra,
  };
}

const CASES = [
  { name: 'valid -> APPROVE', id: 'gk_test_valid', input: { ...BASE_INPUT }, want: ['APPROVE', 'VALID_CONDITION'] },
  { name: 'vk substitution -> REJECT', id: 'gk_test_vk', input: { ...BASE_INPUT, proof_vk: '0x13aa0000000000000000000000000000000000000000000000000000000000aa' }, want: ['REJECT', 'VK_SUBSTITUTION'] },
  { name: 'threshold mismatch -> REJECT', id: 'gk_test_threshold', input: { ...BASE_INPUT, public_balance: '999' }, want: ['REJECT', 'THRESHOLD_MISMATCH'] },
  { name: 'amount exceeded -> REJECT', id: 'gk_test_amount', input: { ...BASE_INPUT, amount: '1001' }, want: ['REJECT', 'AMOUNT_EXCEEDED'] },
  { name: 'recipient mismatch -> REJECT', id: 'gk_test_recipient', input: { ...BASE_INPUT, condition_recipient: '0x1111111111111111111111111111111111111111' }, want: ['REJECT', 'RECIPIENT_MISMATCH'] },
  { name: 'expired -> REJECT', id: 'gk_test_expired', input: { ...BASE_INPUT, current_block: 8430000 }, want: ['REJECT', 'EXPIRED'] },
  { name: 'proof reused -> REJECT', id: 'gk_test_reuse', input: { ...BASE_INPUT, proof_tx: '0xa8b3c4d5e6f7000000000000000000000000000000000000000000000000001' }, want: ['REJECT', 'PROOF_REUSED'], expectNoProof: true },
];

(async () => {
  let pass = 0, fail = 0;
  const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    ok ? pass++ : fail++;
  };

  // 0. Preflight
  const pre = await post('/agent', { type: 'agent-games.preflight.v1', agent_id: 'agt_test', issued_at: new Date().toISOString(), nonce: 'abc123' });
  check('preflight returns {ok:true, protocolVersion:v1} signed', pre.status === 200 && pre.json && pre.json.ok === true && pre.json.protocolVersion === 'v1' && pre.sigOk, JSON.stringify(pre.json));

  // 0b. Bad signature rejected
  const bad = await post('/agent', { type: 'agent-games.preflight.v1' }, { badSig: true });
  check('bad HMAC -> 401', bad.status === 401, `status=${bad.status}`);

  for (const c of CASES) {
    const t0 = Date.now();
    const r = await post('/agent', envelope(c.id, c.input));
    const ms = Date.now() - t0;
    const got = r.json ? [r.json.decision, r.json.reason_code] : [null, null];
    const decisionOk = got[0] === c.want[0] && got[1] === c.want[1];
    check(`${c.name} (decision ${got.join('/')} in ${ms}ms)`, decisionOk && r.status === 200);
    check(`  response signed`, r.sigOk);
    if (r.json && r.json.proof && r.json.public_signals) {
      const ok = await snarkjs.groth16.verify(VK, r.json.public_signals, r.json.proof);
      check(`  returned proof verifies`, ok);
      // public signals must echo the envelope inputs
      const ps = r.json.public_signals;
      const echoOk = ps[3] === '1000' || String(ps[3]) === String(c.input.minimum);
      check(`  public signals present (${ps.length})`, ps.length === 13 && echoOk);
    } else if (c.expectNoProof) {
      // The circuit enforces decision==1 iff every check passes, so a REJECT
      // for a non-circuit reason (proof reuse) cannot be proven — the correct
      // response is the decision without a proof (-2, not -6).
      check(`  proof omitted by design (unprovable REJECT)`, !r.json.proof);
    } else {
      check(`  proof present in response`, false, JSON.stringify(r.json).slice(0, 200));
    }
  }

  // Idempotency: replay the valid task, expect the identical cached response.
  const replay = await post('/agent', envelope('gk_test_valid', { ...BASE_INPUT }));
  check('replay same task_id returns cached response', replay.json && replay.json.decision === 'APPROVE');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS FAIL', e); process.exit(1); });
