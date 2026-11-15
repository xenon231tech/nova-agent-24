# xenon-d62 — Proof Gatekeeper agent

AI agent for the **Proof Gatekeeper** track of zkVerify **Agent Games, Season 01**
(21 Oct – 21 Nov 2026). It judges proof-backed payment tasks and returns a
Groth16 zero-knowledge proof of every decision.

Public identity: **@xenon-d62** —
`https://agentgames.zkverify.io` (competition user
`3a436e43-a5fc-43a3-8657-2b278d4c23ea`).

## How it works

- `POST /agent` receives a signed task envelope.
- The HMAC signature (`x-agent-games-signature`) is verified over the **raw**
  request body before any JSON is parsed.
- Decision is deterministic code, never a model call. APPROVE only when every
  check passes:
  1. `proof_vk` equals `registered_vk` (and the platform-registered key),
  2. `public_balance >= minimum`,
  3. `amount <= max_transfer`,
  4. `recipient == condition_recipient`,
  5. `current_block < expiry_block`,
  6. `proof_tx` not used by another task,
  7. `deadline_at` still in the future.
- Otherwise REJECT with a `reason_code`
  (`VK_SUBSTITUTION`, `THRESHOLD_MISMATCH`, `AMOUNT_EXCEEDED`,
  `RECIPIENT_MISMATCH`, `EXPIRED`, `PROOF_REUSED`).
- Every provable decision ships a local Groth16 proof (official
  `gatekeeper` circuit, `vk_hash`
  `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`)
  plus `public_signals`. Responses are signed with
  `x-agent-games-signature` over the raw response body.
- Preflight (`agent-games.preflight.v1`) answers
  `{ ok: true, protocolVersion: "v1" }`, signed.
- Task IDs are idempotency keys: a retried `task_id` returns the cached
  response instead of being re-decided.

## Proof generation (fast path)

`snarkjs.groth16.fullProve` takes **2.5+ minutes** on a small VM and would
blow the 60-second response deadline. This agent instead:

1. builds the witness with `snarkjs.wtns.calculate` (~63 ms), then
2. proves with the native **rapidsnark** prover (~40 ms),

for ~0.1 s end-to-end (measured). Proofs are verified locally with snarkjs
before being returned.

One subtlety, verified empirically: the circuit enforces
`decision == 1` **iff** every check passes, so a REJECT for a *non-circuit*
reason (e.g. `PROOF_REUSED`, where all circuit inputs are valid) cannot be
proven — the witness assertion fails. For those cases the agent returns the
correct decision **without** a proof (costs −2, not −6).

## Run

```sh
cp .env.example .env   # set AGENT_GAMES_HMAC_SECRET from the dashboard "Rotate Secret"
npm install            # runs setup.sh: downloads circuit artifacts + rapidsnark
npm start              # listens on :3000
```

## Test

```sh
AGENT_GAMES_HMAC_SECRET=test-secret node server.js   # terminal 1
AGENT_GAMES_HMAC_SECRET=test-secret npm test          # terminal 2
```

Replays 1 valid task + 6 trap varieties, checks both directions of HMAC
signing, verifies every returned proof with snarkjs, and checks idempotent
replay. Expected: **30 passed, 0 failed**.

## Deploy

Any host that gives a public HTTPS endpoint on port 443 with no cold-start
sleep. Set `AGENT_GAMES_HMAC_SECRET` from the dashboard (Rotate Secret),
register the full handler path (`https://<host>/agent`) as the agent
endpoint, then run preflight from the dashboard.

## Files

- `server.js` — the agent (plain Node.js, no framework)
- `test-harness.js` — local replay tests
- `verification_key.json` — verification key exported from the zkey
- `setup.sh` — downloads the binary artifacts at install time (not
  committed): `gatekeeper.wasm`, `gatekeeper_final.zkey` from
  `agentgames.zkverify.io/circuits`, and the rapidsnark v0.0.8 prover
  binary (linux x86_64) from GitHub releases
