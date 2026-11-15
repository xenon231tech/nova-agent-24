// Transport-agnostic request processor.
// Takes the RAW request body + signature header, returns { status, body, signature }.
// The transport (server.ts / api/agent.ts) only serializes and sends it.
//
// Flow (spec §02, §04):
//   1. HMAC-verify over the RAW body BEFORE parsing (401 on mismatch).
//   2. Preflight -> { ok: true, protocolVersion: "v1" }, signed.
//   3. Gatekeeper task -> deterministic decide() -> prove -> (APPROVE only)
//      Kurier Finalized -> signed { decision, reason_code, proof, public_signals }.
//   4. Any timeout, error, or uncertainty -> REJECT, never approve by default.
//      Whole-task budget is 50s (platform deadline is 60s).
import { CONFIG } from "./config";
import { verifySignature, signBody } from "./hmac";
import { decide } from "./decide";
import type { GatekeeperInput } from "./decide";
import { generateProof } from "./prove";
import type { ProofBundle } from "./prove";
import { submitAndWaitFinalized } from "./kurier";
import { loadState, saveState, logDecisionLine } from "./state";

export interface ProcessResult {
  status: number;
  body: string;
  signature: string | null;
}

interface GatekeeperEnvelope {
  type?: string;
  task_id?: string;
  mode?: string;
  issued_at?: string;
  deadline_at?: string;
  input?: GatekeeperInput;
}

function respond(status: number, obj: unknown, sign = true): ProcessResult {
  const body = JSON.stringify(obj);
  return {
    status,
    body,
    signature: sign && CONFIG.hmacSecret ? signBody(body) : null,
  };
}

function remainingMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

async function handleGatekeeper(envelope: GatekeeperEnvelope, deadlineMs: number): Promise<ProcessResult> {
  const t0 = Date.now();
  const taskId = String(envelope.task_id || "");
  const mode = envelope.mode || "unknown";
  const input: GatekeeperInput = envelope.input || {};
  const state = loadState();

  if (!taskId) return respond(400, { error: "missing task_id" });

  // Idempotency: a platform retry of the same task_id gets the cached response.
  const cached = state.responsesByTask[taskId];
  if (cached) return respond(200, cached);

  // deadline_at lives at the ENVELOPE top level (spec §02) — fold it into the
  // decision input. Proof generation still uses the original input object.
  const decisionInput: GatekeeperInput = {
    ...input,
    deadline_at: envelope.deadline_at ?? input.deadline_at,
  };

  const isReused = (proofTx: string): boolean => {
    const owner = state.seenProofTx[proofTx];
    return !!owner && owner !== taskId;
  };
  const { decision, reason, provable } = decide(decisionInput, taskId, isReused);

  let proofData: ProofBundle | null = null;
  let finalDecision = decision;
  let finalReason = reason;

  if (decision === "APPROVE") {
    // APPROVE is only provable when the circuit checks pass (decide guarantees it).
    try {
      proofData = await generateProof(input, "APPROVE", taskId, remainingMs(deadlineMs));
    } catch (e) {
      console.error(JSON.stringify({ event: "proof_failed", task_id: taskId, error: (e as Error).message }));
      finalDecision = "REJECT";
      finalReason = "INTERNAL_ERROR";
      proofData = null;
    }
    if (finalDecision === "APPROVE" && proofData) {
      // Finalized-before-approval: submit to Kurier and wait for Finalized.
      // Reserve 3s to serialize and send the response inside the budget.
      const kurierDeadline = Math.min(deadlineMs - 3000, Date.now() + CONFIG.kurierWaitMs);
      const outcome = await submitAndWaitFinalized(proofData.proof, proofData.publicSignals, kurierDeadline);
      if (outcome.mode === "not-finalized") {
        // Fail closed: a proof that is not finalized on-chain does not approve.
        // The circuit cannot prove this REJECT (its checks pass), so no proof.
        finalDecision = "REJECT";
        finalReason = "KURIER_NOT_FINALIZED";
        proofData = null;
      }
      // "skipped" (no KURIER_API_KEY) proceeds on local verification, logged by kurier.ts.
    }
  } else if (provable) {
    // REJECT that the circuit can prove (a circuit check failed): prove it.
    try {
      proofData = await generateProof(input, "REJECT", taskId, remainingMs(deadlineMs));
    } catch (e) {
      console.error(JSON.stringify({ event: "proof_failed", task_id: taskId, error: (e as Error).message }));
      proofData = null; // decision stands; the response just carries no proof.
    }
  }
  // Unprovable REJECT (agent-only check, circuit checks pass): no proof by design.

  const response: Record<string, unknown> = { decision: finalDecision, reason_code: finalReason };
  if (proofData) {
    response.proof = proofData.proof;
    response.public_signals = proofData.publicSignals;
  }
  if (input.proof_tx) response.proof_tx = input.proof_tx;

  // Record proof_tx ownership and cache the response for retries.
  if (input.proof_tx) {
    state.seenProofTx[String(input.proof_tx).toLowerCase()] = taskId;
  }
  state.responsesByTask[taskId] = response;
  saveState();
  logDecisionLine(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "decision",
      task_id: taskId,
      mode,
      decision: finalDecision,
      reason: finalReason,
      proof: !!proofData,
      ms: Date.now() - t0,
    }),
  );
  return respond(200, response);
}

export async function processRequest(
  rawBody: Buffer,
  signatureHeader: string | undefined | null,
): Promise<ProcessResult> {
  if (!CONFIG.hmacSecret) {
    return respond(500, { error: "server misconfigured: missing HMAC secret" }, false);
  }
  const sigOk = verifySignature(rawBody, signatureHeader);
  let envelope: GatekeeperEnvelope;
  try {
    envelope = JSON.parse(rawBody.toString("utf8")) as GatekeeperEnvelope;
  } catch {
    return respond(400, { error: "invalid json" });
  }

  // Preflight is a liveness check, NOT a scored decision: the platform sends
  // it unsigned (verified 2026-11-16: the dashboard preflight diagnostic
  // fails with 401 while a signed preflight of our own passes). Answer it
  // signed regardless — authentication is the SIGNED response, which the
  // platform verifies against the HMAC secret. Never approve anything here.
  if (envelope.type === "agent-games.preflight.v1") {
    return respond(200, { ok: true, protocolVersion: "v1" });
  }
  // Everything else (gatekeeper tasks) stays fail-closed: a valid request
  // signature is required BEFORE any decision or proof work.
  if (!sigOk) {
    console.error(JSON.stringify({ event: "bad_signature" }));
    return respond(401, { error: "invalid signature" }, false);
  }

  try {
    if (envelope.type === "agent-games.proof-gatekeeper.v1") {
      const t0 = Date.now();
      // Whole-task budget: the earlier of the envelope deadline and our 50s cap.
      let deadlineMs = t0 + CONFIG.responseBudgetMs;
      if (envelope.deadline_at) {
        const dl = Date.parse(envelope.deadline_at);
        if (!Number.isNaN(dl)) deadlineMs = Math.min(deadlineMs, dl);
      }
      const work = handleGatekeeper(envelope, deadlineMs);
      const timeout = new Promise<ProcessResult>((resolve) => {
        setTimeout(
          () => resolve(respond(200, { decision: "REJECT", reason_code: "INTERNAL_ERROR" })),
          Math.max(1000, deadlineMs - Date.now()),
        );
      });
      return await Promise.race([work, timeout]);
    }
    return respond(400, { error: "unknown envelope type" });
  } catch (e) {
    console.error(JSON.stringify({ event: "handler_error", error: (e as Error).message }));
    // Fail closed: a handler error must not approve anything.
    if (envelope.type === "agent-games.proof-gatekeeper.v1") {
      return respond(200, { decision: "REJECT", reason_code: "INTERNAL_ERROR" });
    }
    return respond(500, { error: "internal error" });
  }
}
