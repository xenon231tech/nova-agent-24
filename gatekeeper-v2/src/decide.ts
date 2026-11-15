// Deterministic decision logic — the final safety rules, enforced in code.
// NO language model ever makes the final call. APPROVE only when EVERY check
// on the /build Security checklist passes.
//
// Two classes of checks:
//  * Circuit checks — the Groth16 circuit itself constrains decision == 1 iff
//    all of these pass. A REJECT caused by one of them CAN be proven.
//  * Agent-only checks — the circuit does not encode them. A REJECT caused by
//    one of them while the circuit checks pass CANNOT be proven (witness
//    generation would fail), so the response carries no proof (-2, not -6).
//    - registered_vk must equal the OFFICIAL hash: the circuit only checks
//      proof_vk == registered_vk, so equal-but-wrong hashes would still prove.
//    - deadline_at must be in the future.
//    - proof_tx must not have been used for another task.
import { REGISTERED_VK } from "./config";

export type Decision = "APPROVE" | "REJECT";

export type ReasonCode =
  | "VALID_CONDITION"
  | "VK_SUBSTITUTION"
  | "THRESHOLD_MISMATCH"
  | "AMOUNT_EXCEEDED"
  | "RECIPIENT_MISMATCH"
  | "EXPIRED"
  | "PROOF_REUSED"
  | "KURIER_NOT_FINALIZED"
  | "INTERNAL_ERROR";

export interface GatekeeperInput {
  registered_vk?: unknown;
  proof_vk?: unknown;
  minimum?: unknown;
  public_balance?: unknown;
  expiry_block?: unknown;
  current_block?: unknown;
  recipient?: unknown;
  condition_recipient?: unknown;
  amount?: unknown;
  max_transfer?: unknown;
  proof_tx?: unknown;
  deadline_at?: unknown;
}

export interface DecisionResult {
  decision: Decision;
  reason: ReasonCode;
  /** Whether the circuit can prove this decision (see header). */
  provable: boolean;
}

function norm(v: unknown): string {
  return String(v ?? "").toLowerCase();
}

/** Parse a decimal integer (string or number). Null when missing/unparseable. */
function toBig(v: unknown): bigint | null {
  if (v === null || v === undefined || v === "") return null;
  try {
    return BigInt(String(v).trim());
  } catch {
    return null;
  }
}

/**
 * Evaluate the CIRCUIT checks only. Returns the first failing reason, or null
 * when every circuit check passes (circuit decision == 1).
 */
export function circuitCheck(input: GatekeeperInput): ReasonCode | null {
  const registeredVk = norm(input.registered_vk);
  const proofVk = norm(input.proof_vk);
  if (!proofVk || !registeredVk || proofVk !== registeredVk) return "VK_SUBSTITUTION";

  const minimum = toBig(input.minimum);
  const balance = toBig(input.public_balance);
  if (minimum === null || balance === null || balance < minimum) return "THRESHOLD_MISMATCH";

  const amount = toBig(input.amount);
  const maxTransfer = toBig(input.max_transfer);
  if (amount === null || maxTransfer === null || amount > maxTransfer) return "AMOUNT_EXCEEDED";

  const recipient = norm(input.recipient);
  const conditionRecipient = norm(input.condition_recipient);
  if (!recipient || !conditionRecipient || recipient !== conditionRecipient) {
    return "RECIPIENT_MISMATCH";
  }

  const currentBlock = toBig(input.current_block);
  const expiryBlock = toBig(input.expiry_block);
  if (currentBlock === null || expiryBlock === null || currentBlock >= expiryBlock) {
    return "EXPIRED";
  }
  return null;
}

/**
 * Full deterministic decision. `isProofTxReused` answers whether proof_tx was
 * already used for a DIFFERENT task (state lookup, supplied by the caller).
 */
export function decide(
  input: GatekeeperInput,
  taskId: string,
  isProofTxReused: (proofTx: string) => boolean,
): DecisionResult {
  const circuitFail = circuitCheck(input);
  const circuitPass = circuitFail === null;

  // Agent-only check: the registered key must be the OFFICIAL one.
  const registeredVk = norm(input.registered_vk);
  if (!registeredVk || registeredVk !== REGISTERED_VK.toLowerCase()) {
    return { decision: "REJECT", reason: "VK_SUBSTITUTION", provable: !circuitPass };
  }
  if (circuitFail) {
    return { decision: "REJECT", reason: circuitFail, provable: true };
  }

  // Agent-only check: proof reference must not be reused for another task.
  const proofTx = norm(input.proof_tx);
  if (proofTx && isProofTxReused(proofTx)) {
    return { decision: "REJECT", reason: "PROOF_REUSED", provable: false };
  }

  // Agent-only check: deadline_at, when present, must be in the future.
  if (input.deadline_at !== undefined && input.deadline_at !== null && input.deadline_at !== "") {
    const dl = Date.parse(String(input.deadline_at));
    if (!Number.isNaN(dl) && dl <= Date.now()) {
      return { decision: "REJECT", reason: "EXPIRED", provable: false };
    }
  }

  void taskId; // taskId binds the proof (circuit input), not the decision.
  return { decision: "APPROVE", reason: "VALID_CONDITION", provable: true };
}
