// Local Groth16 proof generation with snarkjs + rapidsnark, using the official
// circuit artifacts. Every returned proof is re-verified locally against the
// verification key before it leaves this process.
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import * as snarkjs from "snarkjs";
import { CONFIG, FIELD_P, VK_PATH, WASM_PATH, ZKEY_PATH } from "./config";
import { taskIdToField } from "./taskid";
import type { GatekeeperInput } from "./decide";

const execFileAsync = promisify(execFile);

export interface ProofBundle {
  proof: unknown;
  publicSignals: string[];
}

export interface CircuitInput {
  registeredVkHash: string;
  proofVkHash: string;
  minimum: string;
  publicBalance: string;
  expiryBlock: string;
  currentBlock: string;
  recipient: string;
  conditionRecipient: string;
  amount: string;
  maxTransfer: string;
  decision: number;
  taskId: string;
  salt: string;
}

/** Assemble the exact circuit input layout (same as the verified v1 agent). */
export function buildCircuitInput(
  input: GatekeeperInput,
  decision: "APPROVE" | "REJECT",
  taskId: string,
): CircuitInput {
  const salt = (BigInt("0x" + crypto.randomBytes(31).toString("hex")) % FIELD_P).toString();
  return {
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
    decision: decision === "APPROVE" ? 1 : 0,
    taskId: taskIdToField(taskId),
    salt,
  };
}

let vkCache: unknown = null;
async function loadVk(): Promise<unknown> {
  if (!vkCache) vkCache = JSON.parse(fs.readFileSync(VK_PATH, "utf8"));
  return vkCache;
}

let rapidsnarkResolved: string | null = null;
/**
 * Resolve the rapidsnark binary. On Vercel the bundle dir is read-only and the
 * exec bit may not survive the build — copy the prover to /tmp once per
 * instance and execute that copy.
 */
function getRapidsnark(): string {
  if (rapidsnarkResolved) return rapidsnarkResolved;
  if (process.env.VERCEL === "1") {
    const dst = path.join(os.tmpdir(), "rapidsnark");
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(CONFIG.rapidsnarkPath, dst);
      fs.chmodSync(dst, 0o755);
    }
    rapidsnarkResolved = dst;
    return dst;
  }
  rapidsnarkResolved = CONFIG.rapidsnarkPath;
  return CONFIG.rapidsnarkPath;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Generate a Groth16 proof for the decision and verify it locally.
 * Throws on any failure — the caller must fail closed (REJECT, no proof).
 * Primary path is rapidsnark (~1s); falls back to snarkjs fullProve if the
 * binary is unavailable, within the remaining budget.
 */
export async function generateProof(
  input: GatekeeperInput,
  decision: "APPROVE" | "REJECT",
  taskId: string,
  budgetMs: number,
): Promise<ProofBundle> {
  const circuitInput = buildCircuitInput(input, decision, taskId);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gk-"));
  const t0 = Date.now();
  try {
    const inputPath = path.join(dir, "input.json");
    const witnessPath = path.join(dir, "witness.wtns");
    const proofPath = path.join(dir, "proof.json");
    const publicPath = path.join(dir, "public.json");
    fs.writeFileSync(inputPath, JSON.stringify(circuitInput));

    const remaining = () => Math.max(1000, budgetMs - (Date.now() - t0));
    await withTimeout(
      snarkjs.wtns.calculate(JSON.parse(fs.readFileSync(inputPath, "utf8")), WASM_PATH, witnessPath),
      remaining(),
      "witness calculation",
    );

    let proof: unknown;
    let publicSignals: string[];
    try {
      await withTimeout(
        execFileAsync(getRapidsnark(), [ZKEY_PATH, witnessPath, proofPath, publicPath], {
          timeout: Math.min(CONFIG.proveTimeoutMs, remaining()),
        }),
        remaining(),
        "rapidsnark",
      );
      proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
      publicSignals = JSON.parse(fs.readFileSync(publicPath, "utf8"));
    } catch (e) {
      // Binary missing/slow — fall back to pure-JS proving within budget.
      console.error(JSON.stringify({ event: "rapidsnark_fallback", error: (e as Error).message }));
      const full = await withTimeout(
        snarkjs.groth16.fullProve(circuitInput, WASM_PATH, ZKEY_PATH),
        remaining(),
        "snarkjs fullProve",
      );
      proof = full.proof;
      publicSignals = full.publicSignals;
    }

    // Normalize to a complete snarkjs proof object. rapidsnark's proof.json
    // omits `curve`, and the platform's live (strict) verifier requires the
    // full snarkjs shape { pi_a, pi_b, pi_c, protocol, curve }. The practice
    // verifier accepts the bare rapidsnark shape, which is why this only
    // showed up as proof_failure in live rounds (R03/R04) while practice
    // proofs verified. Local snarkjs.verify ignores `curve`, so this is safe.
    if (proof && typeof proof === "object") {
      const p = proof as Record<string, unknown>;
      if (!p.protocol) p.protocol = "groth16";
      if (!p.curve) p.curve = "bn128";
    }

    const ok = await snarkjs.groth16.verify(await loadVk(), publicSignals, proof);
    if (!ok) throw new Error("local proof verification failed");
    console.log(JSON.stringify({ event: "proof_ok", task_id: String(taskId), ms: Date.now() - t0 }));
    return { proof, publicSignals };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Verify a proof + signals against the verification key (harness use). */
export async function verifyProof(proof: unknown, publicSignals: string[]): Promise<boolean> {
  return snarkjs.groth16.verify(await loadVk(), publicSignals, proof);
}
