// xenon-d62 — Proof Gatekeeper core (transport-agnostic).
// Used by server.js (persistent Node server) and api/agent.js (Vercel function).
// Receives a raw request body + signature header, returns { status, body, signature }.
// The transport serializes the body, sets the signature header, and sends it.
//
// Env:
//   AGENT_GAMES_HMAC_SECRET  32-byte secret from dashboard "Rotate Secret" (required)
//   TASKID_MODE              keccak (default) | numeric | raw
//   SIGNATURE_FORMAT         sha256 (default, "sha256=<hex>") | bare ("<hex>")
//   RAPIDSNARK               path to rapidsnark prover binary (default ./bin/rapidsnark)
//   STATE_DIR                where state.json / decisions.jsonl live (default: this file's dir;
//                            on Vercel set to /tmp, the only writable path on a function)
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const snarkjs = require('snarkjs');
const { keccak_256 } = require('js-sha3');

const HMAC_SECRET = process.env.AGENT_GAMES_HMAC_SECRET || '';
const TASKID_MODE = process.env.TASKID_MODE || 'keccak';
const SIGNATURE_FORMAT = process.env.SIGNATURE_FORMAT || 'sha256';
const RAPIDSNARK_SRC = process.env.RAPIDSNARK || path.join(__dirname, '..', 'bin', 'rapidsnark');
let rapidsnarkPath = null;
function getRapidsnark() {
  if (rapidsnarkPath) return rapidsnarkPath;
  // On Vercel the bundle dir is read-only and the exec bit may not survive
  // the build; copy the prover to /tmp once per instance and exec that copy.
  if (process.env.VERCEL === '1') {
    const dst = path.join(os.tmpdir(), 'rapidsnark');
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(RAPIDSNARK_SRC, dst);
      fs.chmodSync(dst, 0o755);
    }
    rapidsnarkPath = dst;
    return dst;
  }
  rapidsnarkPath = RAPIDSNARK_SRC;
  return RAPIDSNARK_SRC;
}
const WASM = path.join(__dirname, '..', 'gatekeeper.wasm');
const ZKEY = path.join(__dirname, '..', 'gatekeeper_final.zkey');
const VK_PATH = path.join(__dirname, '..', 'verification_key.json');
const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, '..');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const DECISIONS_PATH = path.join(STATE_DIR, 'decisions.jsonl');

// BN254 (alt_bn128) field prime — circuit inputs must be < p.
const FIELD_P = BigInt('21888242871839275222246405745257275088696311157297823662689037894645226208583');
// The platform's registered gatekeeper verification-key hash.
const REGISTERED_VK = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';

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
  if (!HMAC_SECRET || !headerValue) return false;
  let provided = headerValue.trim();
  if (provided.toLowerCase().startsWith('sha256=')) provided = provided.slice(7);
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
function respond(status, obj, sign = true) {
  const body = JSON.stringify(obj);
  return { status, body, signature: sign && HMAC_SECRET ? signBody(body) : null };
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
  const hash = '0x' + keccak_256(s);
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
    await execFileAsync(getRapidsnark(), [ZKEY, witnessPath, proofPath, publicPath], { timeout: 45000 });
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

// ------------------------------------------------------- handlers ---------
function logDecision(taskId, mode, decision, reason, ms) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event: 'decision', task_id: String(taskId), mode, decision, reason, ms });
  console.log(line);
  try { fs.appendFileSync(DECISIONS_PATH, line + '\n'); } catch (_) { /* ignore */ }
}

async function handleGatekeeper(envelope) {
  const t0 = Date.now();
  const taskId = envelope.task_id;
  const mode = envelope.mode || 'unknown';
  const input = envelope.input || {};

  // Idempotency: return the cached response for a retried task_id.
  if (taskId && state.responsesByTask[String(taskId)]) {
    return respond(200, state.responsesByTask[String(taskId)]);
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
  return respond(200, response);
}

function handleSteal(envelope) {
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
  return respond(200, body);
}

// ------------------------------------------------------- entry point ------
// Takes the RAW request body (Buffer) + the x-agent-games-signature header value.
// Returns { status, body (string), signature (string|null) }.
async function processRequest(rawBody, signatureHeader) {
  if (!HMAC_SECRET) {
    return respond(500, { error: 'server misconfigured: missing HMAC secret' }, false);
  }
  if (!verifySignature(rawBody, signatureHeader)) {
    console.error(JSON.stringify({ event: 'bad_signature' }));
    return respond(401, { error: 'invalid signature' }, false);
  }
  let envelope;
  try { envelope = JSON.parse(rawBody.toString('utf8')); }
  catch (_) { return respond(400, { error: 'invalid json' }); }

  try {
    if (envelope.type === 'agent-games.preflight.v1') {
      return respond(200, { ok: true, protocolVersion: 'v1' });
    }
    if (envelope.type === 'agent-games.proof-gatekeeper.v1') {
      return await handleGatekeeper(envelope);
    }
    if (envelope.type === 'agent-games.steal-the-vfy.v1' || envelope.eventId === 'steal-the-vfy') {
      return handleSteal(envelope);
    }
    return respond(400, { error: 'unknown envelope type' });
  } catch (e) {
    console.error(JSON.stringify({ event: 'handler_error', error: e.message }));
    // Fail closed: a handler error must not approve anything. Return a signed REJECT
    // only for gatekeeper envelopes; otherwise a plain 500.
    if (envelope.type === 'agent-games.proof-gatekeeper.v1') {
      return respond(200, { decision: 'REJECT', reason_code: 'INTERNAL_ERROR' });
    }
    return respond(500, { error: 'internal error' });
  }
}

module.exports = { processRequest, verifySignature, decide, taskIdToField };
