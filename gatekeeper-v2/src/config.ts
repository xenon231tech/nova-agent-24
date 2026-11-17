// Runtime configuration for the Proof Gatekeeper agent (v2).
// All secrets come from environment variables only — never hardcode them.
// See .env.example.
import * as path from "path";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

export const CONFIG = {
  /** HMAC secret from the dashboard "Rotate Secret" (32 bytes, shown once). */
  hmacSecret: process.env.AGENT_GAMES_HMAC_SECRET || "",
  /** Port for the standalone server (server.ts). Vercel ignores this. */
  port: parseInt(process.env.PORT || "3000", 10),
  /** taskId -> field element mapping: "uuidTail" (default) | "keccak" | "numeric" | "raw". */
  taskIdMode: (process.env.TASKID_MODE || "uuidTail") as "uuidTail" | "keccak" | "numeric" | "raw",
  /** Response signature format: "sha256" ("sha256=<hex>", default) | "bare" ("<hex>"). */
  signatureFormat: (process.env.SIGNATURE_FORMAT || "bare") as "sha256" | "bare", // bare: the platform verifies response signatures against raw hex (v1 proved this; "sha256=" fails its preflight)
  /** Kurier API key (mainnet). Unset = skip Kurier, rely on local verification (logged). */
  kurierApiKey: process.env.KURIER_API_KEY || "",
  /** Kurier base URL. Default is mainnet; override for testnet. */
  kurierApiUrl: process.env.KURIER_API_URL || "https://api.kurier.xyz/api/v1",
  /** Total internal budget per task in ms. The platform deadline is 60s; keep 10s of margin. */
  responseBudgetMs: parseInt(process.env.RESPONSE_BUDGET_MS || "50000", 10),
  /** Max ms to wait for a Kurier Finalized result on the APPROVE path. */
  kurierWaitMs: parseInt(process.env.KURIER_WAIT_MS || "40000", 10),
  /** Poll interval for Kurier job status (docs recommend 5s). */
  kurierPollMs: parseInt(process.env.KURIER_POLL_MS || "5000", 10),
  /** Max ms for one proof generation attempt (rapidsnark is normally ~1s). */
  proveTimeoutMs: parseInt(process.env.PROVE_TIMEOUT_MS || "20000", 10),
  /** Path to the rapidsnark prover binary. */
  rapidsnarkPath: process.env.RAPIDSNARK || path.join(__dirname, "..", "bin", "rapidsnark"),
  /** Directory for idempotency state (state.json / decisions.jsonl). /tmp on Vercel. */
  stateDir: process.env.STATE_DIR || path.join(__dirname, ".."),
} as const;

/** Throws at startup when the HMAC secret is missing — fail closed. */
export function assertHmacSecret(): void {
  requiredEnv("AGENT_GAMES_HMAC_SECRET");
}

/** BN254 (alt_bn128) field prime — every circuit input must be < p. */
export const FIELD_P = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583",
);

/**
 * The platform's registered gatekeeper verification-key hash
 * (https://agentgames.zkverify.io/api/circuit-info, "mainnet").
 * The circuit itself only checks proof_vk == registered_vk; it CANNOT know
 * which hash the platform registered — so the agent must check the value
 * itself (see decide.ts). A proof with both hashes equal-but-wrong would
 * verify cryptographically and still be a trap.
 */
export const REGISTERED_VK =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";

/** Circuit artifacts (official, from /build). */
export const WASM_PATH = path.join(__dirname, "..", "circuits", "gatekeeper.wasm");
export const ZKEY_PATH = path.join(__dirname, "..", "circuits", "gatekeeper_final.zkey");
export const VK_PATH = path.join(__dirname, "..", "circuits", "verification_key.json");

/**
 * Public signals layout (output-then-public order, as snarkjs returns them):
 * [0] commitment binding salt+task (circuit output),
 * [1] registeredVkHash, [2] proofVkHash, [3] minimum, [4] publicBalance,
 * [5] expiryBlock, [6] currentBlock, [7] recipient, [8] conditionRecipient,
 * [9] amount, [10] maxTransfer, [11] decision, [12] taskId.
 * Salt is a private input and never appears in the signals.
 */
export const PUBLIC_SIGNAL_COUNT = 13;
export const SIGNAL_INDEX = {
  commitment: 0,
  registeredVkHash: 1,
  proofVkHash: 2,
  minimum: 3,
  publicBalance: 4,
  expiryBlock: 5,
  currentBlock: 6,
  recipient: 7,
  conditionRecipient: 8,
  amount: 9,
  maxTransfer: 10,
  decision: 11,
  taskId: 12,
} as const;
