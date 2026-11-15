// Test harness: replays sample Proof Gatekeeper envelopes (1 valid + traps)
// against a locally running server, verifies HMAC signatures both ways and
// verifies every returned Groth16 proof with snarkjs.
//
// Usage:
//   AGENT_GAMES_HMAC_SECRET=test-secret node dist/server.js   # terminal 1 (port 3000)
//   node dist/test/harness.js                                  # terminal 2
// Env: AGENT_URL (default http://127.0.0.1:3000), AGENT_GAMES_HMAC_SECRET (default test-secret)
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as snarkjs from "snarkjs";
import { verifyProof } from "../src/prove";
import { taskIdToField } from "../src/taskid";
import { SIGNAL_INDEX } from "../src/config";

const BASE = process.env.AGENT_URL || "http://127.0.0.1:3000";
const SECRET = process.env.AGENT_GAMES_HMAC_SECRET || "test-secret";
const VK = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "circuits", "verification_key.json"), "utf8"),
);

function hmacHex(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

function signCheck(body: string, headerValue: string | null): boolean {
  if (!headerValue) return false;
  let provided = headerValue.trim();
  if (provided.toLowerCase().startsWith("sha256=")) provided = provided.slice(7);
  try {
    return crypto.timingSafeEqual(Buffer.from(provided.toLowerCase()), Buffer.from(hmacHex(body)));
  } catch {
    return false;
  }
}

interface PostResult {
  status: number;
  json: Record<string, unknown> | null;
  text: string;
  sigOk: boolean;
}

async function post(pathname: string, obj: unknown, badSig = false): Promise<PostResult> {
  const body = JSON.stringify(obj);
  const sig = badSig ? "sha256=00" : `sha256=${hmacHex(body)}`;
  const res = await fetch(BASE + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-games-signature": sig },
    body,
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text, sigOk: signCheck(text, res.headers.get("x-agent-games-signature")) };
}

const BASE_INPUT = {
  registered_vk: "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",
  proof_vk: "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",
  minimum: "1000",
  public_balance: "1460",
  expiry_block: 8430000,
  current_block: 8420000,
  recipient: "0xDe42a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8",
  condition_recipient: "0xDe42a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8",
  amount: "500",
  max_transfer: "1000",
  proof_tx: "0xa8b3c4d5e6f7000000000000000000000000000000000000000000000000001",
};

function envelope(taskId: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "practice",
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60000).toISOString(),
    input,
    ...extra,
  };
}

interface Case {
  name: string;
  id: string;
  input: Record<string, unknown>;
  want: [string, string];
  expectNoProof?: boolean;
  extra?: Record<string, unknown>;
}

const CASES: Case[] = [
  { name: "valid -> APPROVE", id: "gk_test_valid", input: { ...BASE_INPUT }, want: ["APPROVE", "VALID_CONDITION"] },
  { name: "vk substitution -> REJECT", id: "gk_test_vk", input: { ...BASE_INPUT, proof_vk: "0x13aa0000000000000000000000000000000000000000000000000000000000aa" }, want: ["REJECT", "VK_SUBSTITUTION"] },
  {
    name: "vk equal-but-wrong -> REJECT, no proof",
    id: "gk_test_vk2",
    input: { ...BASE_INPUT, registered_vk: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", proof_vk: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    want: ["REJECT", "VK_SUBSTITUTION"],
    expectNoProof: true,
  },
  { name: "threshold mismatch -> REJECT", id: "gk_test_threshold", input: { ...BASE_INPUT, public_balance: "999" }, want: ["REJECT", "THRESHOLD_MISMATCH"] },
  { name: "amount exceeded -> REJECT", id: "gk_test_amount", input: { ...BASE_INPUT, amount: "1001" }, want: ["REJECT", "AMOUNT_EXCEEDED"] },
  { name: "recipient mismatch -> REJECT", id: "gk_test_recipient", input: { ...BASE_INPUT, condition_recipient: "0x1111111111111111111111111111111111111111" }, want: ["REJECT", "RECIPIENT_MISMATCH"] },
  { name: "expired block -> REJECT", id: "gk_test_expired", input: { ...BASE_INPUT, current_block: 8430000 }, want: ["REJECT", "EXPIRED"] },
  {
    name: "deadline passed -> REJECT, no proof",
    id: "gk_test_deadline",
    // Distinct proof_tx (set per-run in main) so the reuse check does not fire first.
    input: { ...BASE_INPUT },
    want: ["REJECT", "EXPIRED"],
    expectNoProof: true,
    extra: { deadline_at: new Date(Date.now() - 1000).toISOString() },
  },
  {
    name: "proof reused -> REJECT, no proof",
    id: "gk_test_reuse",
    input: { ...BASE_INPUT, proof_tx: "0xa8b3c4d5e6f7000000000000000000000000000000000000000000000000001" },
    want: ["REJECT", "PROOF_REUSED"],
    expectNoProof: true,
  },
];

async function main(): Promise<void> {
  // Unique task ids AND proof_tx values per run — the agent caches responses
  // by task_id and remembers proof_tx ownership, so reusing either across
  // runs would return stale cached decisions / false PROOF_REUSED.
  const RUN = Date.now().toString(36);
  const runId = (id: string): string => `${id}_${RUN}`;
  const proofTx = (tag: string): string =>
    ("0x" + Buffer.from(`${RUN}-${tag}`).toString("hex")).slice(0, 66).padEnd(66, "0");
  const txValid = proofTx("valid");
  const txDeadline = proofTx("deadline");
  for (const c of CASES) {
    c.input.proof_tx = c.id === "gk_test_deadline" ? txDeadline : txValid;
  }
  let pass = 0;
  let fail = 0;
  const check = (name: string, ok: boolean, extra = ""): void => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
    if (ok) pass++;
    else fail++;
  };

  // 0. Preflight
  const pre = await post("/agent", { type: "agent-games.preflight.v1", agent_id: "agt_test", issued_at: new Date().toISOString(), nonce: "abc123" });
  check(
    "preflight returns {ok:true, protocolVersion:v1} signed",
    pre.status === 200 && !!pre.json && pre.json.ok === true && pre.json.protocolVersion === "v1" && pre.sigOk,
    JSON.stringify(pre.json),
  );

  // 0b. Unsigned preflight is still answered (signed): the platform's
  // dashboard diagnostic sends preflight WITHOUT a signature; auth is the
  // SIGNED response. A bad signature on a TASK must still 401.
  const unsignedBody = JSON.stringify({ type: "agent-games.preflight.v1", agent_id: "agt_test", issued_at: new Date().toISOString(), nonce: "unsigned1" });
  const unsignedRes = await fetch(BASE + "/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: unsignedBody });
  const unsignedText = await unsignedRes.text();
  let unsignedJson: Record<string, unknown> | null = null;
  try { unsignedJson = JSON.parse(unsignedText) as Record<string, unknown>; } catch { /* ignore */ }
  check(
    "unsigned preflight -> 200 signed {ok:true, protocolVersion:v1}",
    unsignedRes.status === 200 && !!unsignedJson && unsignedJson.ok === true && unsignedJson.protocolVersion === "v1" && signCheck(unsignedText, unsignedRes.headers.get("x-agent-games-signature")),
    `status=${unsignedRes.status}`,
  );
  const badTask = await post("/agent", envelope(runId("gk_test_badsig"), { ...CASES[0].input }), true);
  check("bad HMAC on task -> 401", badTask.status === 401, `status=${badTask.status}`);

  for (const c of CASES) {
    const t0 = Date.now();
    const r = await post("/agent", envelope(runId(c.id), c.input, c.extra || {}));
    const ms = Date.now() - t0;
    const got: [unknown, unknown] = r.json ? [r.json.decision, r.json.reason_code] : [null, null];
    const decisionOk = got[0] === c.want[0] && got[1] === c.want[1];
    check(`${c.name} (decision ${got.join("/")} in ${ms}ms)`, decisionOk && r.status === 200);
    check("  response signed", r.sigOk);
    const proof = r.json?.proof as unknown;
    const signals = r.json?.public_signals as string[] | undefined;
    if (proof && signals) {
      const ok = await verifyProof(proof, signals);
      check("  returned proof verifies", ok);
      // Public signals must echo the envelope inputs (output-then-public order).
      const echoOk =
        signals.length === 13 &&
        signals[SIGNAL_INDEX.minimum] === String(c.input.minimum) &&
        signals[SIGNAL_INDEX.decision] === (c.want[0] === "APPROVE" ? "1" : "0") &&
        signals[SIGNAL_INDEX.taskId] === taskIdToField(runId(c.id));
      check(`  public signals layout ok (${signals.length})`, echoOk);
      void snarkjs;
      void VK;
    } else if (c.expectNoProof) {
      // The circuit enforces decision==1 iff every check passes, so a REJECT
      // for an agent-only reason cannot be proven — the correct response is
      // the decision without a proof (-2, not -6).
      check("  proof omitted by design (unprovable REJECT)", !r.json?.proof);
    } else {
      check("  proof present in response", false, JSON.stringify(r.json).slice(0, 200));
    }
  }

  // Idempotency: replay the valid task, expect the identical cached response.
  const replay = await post("/agent", envelope(runId("gk_test_valid"), { ...CASES[0].input }));
  check("replay same task_id returns cached response", !!replay.json && replay.json.decision === "APPROVE");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("HARNESS FAIL", e);
  process.exit(1);
});
