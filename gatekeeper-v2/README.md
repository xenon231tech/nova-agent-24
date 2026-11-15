# xenon-gatekeeper-v2 — Proof Gatekeeper agent (zkVerify Agent Games, Season 01)

TypeScript agent for the Proof Gatekeeper track. Receives signed task
envelopes at a public HTTPS endpoint, decides APPROVE/REJECT with
deterministic code, proves the decision with a local Groth16 proof (snarkjs),
and — on the APPROVE path — submits the proof to Kurier and waits for a
Finalized result before approving. Fail closed on any timeout, error, or
uncertainty. No model makes the final call.

## File structure

```
gatekeeper-v2/
  src/
    config.ts    env + constants (registered VK hash, field prime, budgets)
    hmac.ts      HMAC-SHA256 verify/sign over raw bodies
    taskid.ts    task_id -> BN254 field element (keccak/numeric/raw)
    decide.ts    deterministic decision logic + reason codes
    prove.ts     snarkjs witness + rapidsnark proof + local verify
    kurier.ts    Kurier submit + poll to Finalized
    state.ts     idempotency state (proof_tx ownership, cached responses)
    handler.ts   processRequest: HMAC -> preflight/task -> decide/prove/Kurier
    server.ts    standalone HTTP server (:3000)
  api/
    agent.ts     Vercel serverless entry (POST /api/agent)
  test/
    harness.ts   replays sample envelopes (valid + 7 traps)
  circuits/      official artifacts: gatekeeper.wasm, gatekeeper_final.zkey,
                 verification_key.json (SHA-256 verified against the published
                 values be00aefe… / adfe95a4…)
  bin/           rapidsnark prover binary
  .env.example   blank secrets — copy to .env, never commit .env
```

## Setup

```bash
npm install
cp .env.example .env   # fill in AGENT_GAMES_HMAC_SECRET (dashboard "Rotate Secret")
npm run build
AGENT_GAMES_HMAC_SECRET=test-secret npm start   # local server on :3000 (dist/src/server.js)
```

## Test

```bash
# terminal 1: AGENT_GAMES_HMAC_SECRET=test-secret npm start
# terminal 2:
npm test
```

The harness checks: preflight (signed), bad HMAC -> 401, valid -> APPROVE
with a locally-verifying proof, 7 traps -> the right REJECT + reason_code,
proof omitted exactly for unprovable REJECTs, response signatures, and
idempotent replay of a task_id.

## How decisions are made (spec §04 security checklist)

APPROVE only when every check passes:

1. `proof_vk` equals `registered_vk` (circuit check).
2. `registered_vk` equals the official registered hash
   `0x6b79c6…d77b0` (agent-only — the circuit only checks equality, so
   equal-but-wrong hashes would still prove; this check catches them).
3. `public_balance >= minimum`.
4. `amount <= max_transfer`.
5. `recipient == condition_recipient`.
6. `current_block < expiry_block`.
7. `deadline_at` in the future (when present).
8. `proof_tx` not already used for another task.
9. APPROVE path only: Kurier job reaches **Finalized** within budget.

Otherwise REJECT with a `reason_code` (`VK_SUBSTITUTION`,
`THRESHOLD_MISMATCH`, `AMOUNT_EXCEEDED`, `RECIPIENT_MISMATCH`, `EXPIRED`,
`PROOF_REUSED`, `KURIER_NOT_FINALIZED`, `INTERNAL_ERROR`).

Proof rules: the circuit constrains `decision == 1` iff its own checks pass.
A REJECT caused by an agent-only check (2, 7, 8, 9) while the circuit checks
pass cannot be proven, so the response carries no proof — a -2, not a -6.

## Public signals (output-then-public order, as snarkjs returns them)

`[commitment, registeredVkHash, proofVkHash, minimum, publicBalance,
expiryBlock, currentBlock, recipient, conditionRecipient, amount,
maxTransfer, decision, taskId]` — 13 signals. Signal 0 is the circuit's
commitment output binding the private salt to the task.

## Kurier

`KURIER_API_KEY` (mainnet, from kurier.xyz) enables submit + poll to
Finalized on the APPROVE path (poll every 5s, bounded by `KURIER_WAIT_MS`,
default 40s, inside the 50s response budget). Without the key, Kurier is
skipped (logged) and the agent relies on local verification + the platform's
own re-verification. `KURIER_API_URL` overrides the base URL (testnet:
`https://api-testnet.kurier.xyz/api/v1`).

## taskId mapping

The /build spec does not publish how `task_id` maps to the circuit field.
`TASKID_MODE` selects it: `keccak` (default, keccak256 mod p), `numeric`
(digits mod p), `raw` (integer). Validate the choice with Practice mode on
the dashboard — the correct mode is the one whose proofs the platform
verifies. (v1 ran `keccak` and answered 6/8 tasks in R03 with 0 proofs
verified, which is why this is configurable.)

## Deploy (Vercel)

```bash
vercel --prod   # project root; set AGENT_GAMES_HMAC_SECRET (+ KURIER_API_KEY) in the dashboard
```

Endpoint: `https://<project>.vercel.app/api/agent`. Register the full handler
path on the Agent Games dashboard, rotate the secret, set it as
`AGENT_GAMES_HMAC_SECRET`, restart, then run preflight — it must pass
before the platform marks the agent active. Max function duration is 60s
(`vercel.json`); the internal budget is 50s.

## Secrets

Never paste a private key, seed phrase, or API key into chat, and never
commit `.env`. All secrets load from environment variables only. Nothing
secret is ever logged (logs carry header shapes and job ids only).
