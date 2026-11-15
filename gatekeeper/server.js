// xenon-d62 — Proof Gatekeeper agent for zkVerify Agent Games (Season 01).
// Plain Node.js (no framework). Receives signed task envelopes at POST /agent,
// decides APPROVE/REJECT with deterministic checks, generates a local Groth16
// proof with rapidsnark (witness via snarkjs), and returns a signed response.
//
// Env:
//   AGENT_GAMES_HMAC_SECRET  32-byte secret from dashboard "Rotate Secret" (required)
//   PORT                     default 3000
//   TASKID_MODE              keccak (default) | numeric | raw — how task_id maps to a circuit field element
//   SIGNATURE_FORMAT         sha256 (default, "sha256=<hex>") | bare ("<hex>")
//   RAPIDSNARK               path to rapidsnark prover binary (default ./bin/rapidsnark)
//
// Proof pipeline (measured on this VM): witness 63ms + rapidsnark prove 40ms.
// snarkjs fullProve is NOT used — it takes 2.5+ min here and would blow the 60s deadline.
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const snarkjs = require('snarkjs');
// ethers is only used for keccak256 (taskId mapping). It is a declared dependency.
const { ethers } = require('ethers');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HMAC_SECRET = process.env.AGENT_GAMES_HMAC_SECRET || '';
const TASKID_MODE = process.env.TASKID_MODE || 'keccak';
const SIGNATURE_FORMAT = process.env.SIGNATURE_FORMAT || 'sha256';
const RAPIDSNARK = process.env.RAPIDSNARK || path.join(__dirname, 'bin', 'rapidsnark');
const WASM = path.join(__dirname, 'gatekeeper.wasm');
const ZKEY = path.join(__dirname, 'gatekeeper_final.zkey');
const VK_PATH = path.join(__dirname, 'verification_key.json');
const STATE_PATH = path.join(__dirname, 'state.json');

// BN254 (alt_bn128) field prime — circuit inputs must be < p.
const FIELD_P = BigInt('21888242871839275222246405745257275088696311157297823662689037894645226208583');
// The platform's registered gatekeeper verification-key hash.
const REGISTERED_VK = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';

if (!HMAC_SECRET) {
  console.error('FATAL: AGENT_GAMES_HMAC_SECRET is not set. Refusing to start.');
  process.exit(1);
}

// ---------------------------------------------------------------- state ---
let state = { seenProofTx: {}, responsesByTask: {} };
try {
  if (fs.existsSync(STATE_PATH)) state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
} catch (e) { console.error('state load failed, starting fresh:', e.message); }
function saveState() {
  try { fs.writeFileSync(STATE_PATH + '.tmp', JSON.stringify(state)); fs.renameSync(STATE_PATH + '.tmp', STATE_PATH); }
  catch (e) { console.error('state save failed:', e.message); }
}

let vKey = null;
async function loadVk() {
  if (!vKey) vKey = JSON.parse(fs.readFileSync(VK_PATH, 'utf8'));
  return vKey;
}

// ---------------------------------------------------------------- hmac ----
function hmacHex(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}
function verifySignature(rawBody, headerValue) {
  if (!headerValue) return false;
  let provided = headerValue.trim();
  if (provided.toLowerCase().startsWith('sha256=')) provided = provided.slice(7);
  // Also accept base64 form, just in case the platform uses it.
  const expectedHex = hmacHex(HMAC_SECRET, rawBody);
  let candidates = [provided.toLowerCase()];
  try { candidates.push(Buffer.from(provided, 'base64').toString('hex')); } catch (_) { /* ignore */ }
  return candidates.some((c) => {
    try { return crypto.timingSafeEqual(Buffer.from(c), Buffer.from(expectedHex)); }
    catch (_) { return false; }
  });
}
function signBody(rawBody) {
  const hex = hmacHex(HMAC_SECRET, rawBody);
  return SIGNATURE_FORMAT === 'bare' ? hex : `sha256=${hex}`;
}

// ------------------------------------------------------- taskId mapping ---
function taskIdToField(taskId) {
  const s = String(taskId);
  if (TASKID_MODE === 'raw') return BigInt(s).toString();
  if (TASKID_MODE === 'numeric') {
    const digits = s.replace(/[^0-9]/g, '') || '0';
    return (BigInt(digits) % FIELD_P).toString();
  }
  // default: keccak256(task_id) mod p — the standard way to bind a string id to a field element.
  const hash = ethers.keccak256(ethers.toUtf8Bytes(s));
  return (BigInt(hash) % FIELD_P).toString();
}

// ------------------------------------------------------- decision logic ---
// Pure function: APPROVE only when EVERY check passes. Returns { decision, reason }.
function decide(input, taskId) {
  const norm = (v) => String(v || '').toLowerCase();
  const toBig = (v) => BigInt(String(v));
  const now = Date.now();

  const registeredVk = norm(input.registered_vk);
  const proofVk = norm(input.proof_vk);
  if (!proofVk || registeredVk !== proofVk) return { decision: 'REJECT', reason: 'VK_SUBSTITUTION' };
  if (registeredVk !== REGISTERED_VK) return { decision: 'REJECT', reason: 'VK_SUBSTITUTION' };
  if (toBig(input.public_balance) < toBig(input.minimum)) return { decision: 'REJECT', reason: 'THRESHOLD_MISMATCH' };
  if (toBig(input.amount) > toBig(input.max_transfer)) return { decision: 'REJECT', reason: 'AMOUNT_EXCEEDED' };
  if (norm(input.recipient) !== norm(input.condition_recipient)) return { decision: 'REJECT', reason: 'RECIPIENT_MISMATCH' };
  if (toBig(input.current_block) >= toBig(input.expiry_block)) return { decision: 'REJECT', reason: 'EXPIRED' };
  if (input.proof_tx) {
    const owner = state.seenProofTx[norm(input.proof_tx)];
    if (owner && owner !== String(taskId)) return { decision: 'REJECT', reason: 'PROOF_REUSED' };
  }
  // deadline_at, when present, must be in the future.
  if (input.deadline_at) {
    const dl = Date.parse(input.deadline_at);
    if (!Number.isNaN(dl) && dl <= now) return { decision: 'REJECT', reason: 'EXPIRED' };
  }
  return { decision: 'APPROVE', reason: 'VALID_CONDITION' };
}

// ------------------------------------------------------- proof generation --
async function generateProof(input, decision, taskId) {
  const taskIdField = taskIdToField(taskId);
  const salt = (BigInt('0x' + crypto.randomBytes(31).toString('hex')) % FIELD_P).toString();
  const circuitInput = {
    registeredVkHash: String(input.registered_vk),
    proofVkHash: String(input.proof_vk),
    minimum: String(input.minimum),
    publicBalance: String(input.public_balance),
    expiryBlock: String(input.expiry_block),
    currentBlock: String(input.current_block),
    recipient: String(input.recipient),
    conditionRecipient: String(input.condition_recipient),
    amount: String(input.amount),
    maxTransfer: String(input.max_transfer),
    decision: decision === 'APPROVE' ? 1 : 0,
    taskId: taskIdField,
    salt,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-'));
  try {
    const inputPath = path.join(dir, 'input.json');
    const witnessPath = path.join(dir, 'witness.wtns');
    const proofPath = path.join(dir, 'proof.json');
    const publicPath = path.join(dir, 'public.json');
    fs.writeFileSync(inputPath, JSON.stringify(circuitInput));
    const t0 = Date.now();
    await snarkjs.wtns.calculate(JSON.parse(fs.readFileSync(inputPath, 'utf8')), WASM, witnessPath);
    await execFileAsync(RAPIDSNARK, [ZKEY, witnessPath, proofPath, publicPath], { timeout: 45000 });
    const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
    const publicSignals = JSON.parse(fs.readFileSync(publicPath, 'utf8'));
    const ok = await snarkjs.groth16.verify(await loadVk(), publicSignals, proof);
    if (!ok) throw new Error('local proof verification failed');
    console.log(JSON.stringify({ event: 'proof_ok', task_id: String(taskId), ms: Date.now() - t0 }));
    return { proof, public_signals: publicSignals };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

// ------------------------------------------------------- response helpers --
function sendJson(res, status, obj, sign = true) {
  const body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json' };
  if (sign) headers['x-agent-games-signature'] = signBody(body);
  res.writeHead(status, headers);
  res.end(body);
}
function logDecision(taskId, mode, decision, reason, ms) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event: 'decision', task_id: String(taskId), mode, decision, reason, ms });
  console.log(line);
  try { fs.appendFileSync(path.join(__dirname, 'decisions.jsonl'), line + '\n'); } catch (_) { /* ignore */ }
}

// ------------------------------------------------------- handlers ---------
async function handleGatekeeper(envelope, res) {
  const t0 = Date.now();
  const taskId = envelope.task_id;
  const mode = envelope.mode || 'unknown';
  const input = envelope.input || {};

  // Idempotency: return the cached response for a retried task_id.
  if (taskId && state.responsesByTask[String(taskId)]) {
    sendJson(res, 200, state.responsesByTask[String(taskId)]);
    return;
  }

  const { decision, reason } = decide(input, taskId);
  let proofData = null;
  try {
    proofData = await generateProof(input, decision, taskId);
  } catch (e) {
    console.error(JSON.stringify({ event: 'proof_failed', task_id: String(taskId), error: e.message }));
    // Fail closed on the proof, not on the decision: return the decision without proof (-2, not -6).
  }

  const response = { decision, reason_code: reason, ...(proofData || {}) };
  if (input.proof_tx) response.proof_tx = input.proof_tx;

  // Record proof_tx ownership (only after a successful decision) and cache the response.
  if (input.proof_tx) { state.seenProofTx[String(input.proof_tx).toLowerCase()] = String(taskId); }
  if (taskId) { state.responsesByTask[String(taskId)] = response; }
  saveState();
  logDecision(taskId, mode, decision, reason, Date.now() - t0);
  sendJson(res, 200, response);
}

function handleSteal(envelope, res) {
  // v1: Gatekeeper only. If a Steal turn ever arrives, answer a schema-valid
  // HOLD with no proof rather than erroring (a missing/mismatched field is a HOLD).
  const body = {
    matchId: envelope.matchId || '',
    turn: envelope.turn || 0,
    action: { type: 'HOLD' },
    agentTimestamp: new Date().toISOString(),
    idempotencyKey: crypto.randomUUID(),
  };
  console.log(JSON.stringify({ event: 'steal_hold_stub', match_id: body.matchId, turn: body.turn }));
  sendJson(res, 200, body);
}

// ------------------------------------------------------- server -----------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    return sendJson(res, 200, { ok: true, service: 'xenon-d62-gatekeeper', version: 'v1' }, false);
  }
  if (req.method !== 'POST' || req.url !== '/agent') {
    return sendJson(res, 404, { error: 'not found' }, false);
  }

  const chunks = [];
  req.on('data', (c) => {
    chunks.push(c);
    if (Buffer.concat(chunks).length > 1024 * 1024) { req.destroy(); }
  });
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks);
    if (!verifySignature(rawBody, req.headers['x-agent-games-signature'])) {
      console.error(JSON.stringify({ event: 'bad_signature', url: req.url }));
      return sendJson(res, 401, { error: 'invalid signature' }, false);
    }
    let envelope;
    try { envelope = JSON.parse(rawBody.toString('utf8')); }
    catch (_) { return sendJson(res, 400, { error: 'invalid json' }); }

    try {
      if (envelope.type === 'agent-games.preflight.v1') {
        return sendJson(res, 200, { ok: true, protocolVersion: 'v1' });
      }
      if (envelope.type === 'agent-games.proof-gatekeeper.v1') {
        return await handleGatekeeper(envelope, res);
      }
      if (envelope.type === 'agent-games.steal-the-vfy.v1' || envelope.eventId === 'steal-the-vfy') {
        return handleSteal(envelope, res);
      }
      return sendJson(res, 400, { error: 'unknown envelope type' });
    } catch (e) {
      console.error(JSON.stringify({ event: 'handler_error', error: e.message }));
      // Fail closed: a handler error must not approve anything. Return a signed REJECT
      // only for gatekeeper envelopes; otherwise a plain 500.
      if (envelope.type === 'agent-games.proof-gatekeeper.v1') {
        return sendJson(res, 200, { decision: 'REJECT', reason_code: 'INTERNAL_ERROR' });
      }
      return sendJson(res, 500, { error: 'internal error' });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`xenon-d62 gatekeeper listening on :${PORT} (taskid=${TASKID_MODE}, sig=${SIGNATURE_FORMAT})`);
});
