# Creator Track — Article (READY to submit)

**Track:** Creator Track (article, manual review)
**Submit from:** Agent Games dashboard → Submissions → New submission
**Author:** Mohamad Ikhsan (@xenon-d62)
**Status:** READY — updated 2026-11-15 ~12:00 WIB. Agent is registered, endpoint
live, preflight passed, dashboard shows active. All receipts below are real
and verifiable today.

---

## Title (pick one)

1. **Don't Trust the Agent. Verify It — I Built a Proof Gatekeeper in a Day**
2. **My Agent Proves Every Decision in 0.1 Seconds. Here's How.**
3. **I Registered for zkVerify Agent Games with a Script, Then Built the Judge**

Recommended: **#1** (direct, matches the track's theme).

---

## Article

### Don't Trust the Agent. Verify It.

AI agents are about to move real money. They will approve payments, sign
transactions, and make promises on behalf of people who never see the
keystrokes. The question zkVerify's Agent Games asks is the right one: when an
agent says "I checked the proof", how do you know it did?

I spent a day answering that question by building the thing itself: a Proof
Gatekeeper agent for Season 01 that judges proof-backed payment requests and
attaches a Groth16 zero-knowledge proof to every decision it makes. Not a
promise. A proof.

### Step 1: Registering without the UI

The competition lets you register with X or a wallet. The wallet button in
the UI didn't cooperate, so I registered the way an agent should: with code.

The flow is SIWE (Sign-In With Ethereum): fetch a nonce from
`/api/auth/wallet/siwe/nonce`, build an EIP-4361 message
("Sign in to Agent Games with your wallet."), sign it with the wallet, and POST
the message and signature to `/api/auth/callback/wallet`. That returned a
session cookie, and the session confirmed it:

- Handle: **xenon-d62**
- Competition user ID: `3a436e43-a5fc-43a3-8657-2b278d4c23ea`
- Wallet: `0xe28a…fc3e`

My first attempts failed — I had put the CSRF token where the nonce belonged,
and the statement line was missing. The fix came from reading the registration
page's own JavaScript bundle, which showed the exact message format. Lesson
one: when the UI hides the protocol, the shipped JS is the documentation.

### Step 2: The circuit is the spec

The Gatekeeper track publishes its circuit: `gatekeeper.wasm` and
`gatekeeper_final.zkey`, with a verification-key hash registered on zkVerify
mainnet (`0x6b79c6…d77b0`). The agent's job is simple to state and strict to
implement: APPROVE a payment only when every item on the security checklist
passes — the verification key matches the registered one, the public balance
clears the minimum, the amount is within the transfer cap, the recipient is
exactly the conditioned recipient, the request hasn't expired, and the proof
reference hasn't been used before. Anything else is a REJECT with a reason
code. The final call is deterministic code, never a language model.

I proved the circuit works locally before writing a line of agent code:
`snarkjs.groth16.fullProve` on a valid scenario (balance 1460 vs minimum 1000,
amount 500 vs cap 1000, matching recipients and keys) produced a proof that
verified `true` against the exported verification key.

### Step 3: The 60-second problem

There is a hard 60-second response deadline per task. The pure-JavaScript
prover took **over 2.5 minutes** on my small VM. That is not a tuning problem;
it is a dead end.

The fix is the native prover, rapidsnark. Same circuit, same inputs:

- Witness generation (snarkjs, wasm): **63 ms**
- Proof generation (rapidsnark): **40 ms**
- Local verification: instant

Total proof pipeline: **~0.1 seconds**, verified `true` by snarkjs. The
deadline went from impossible to irrelevant.

### Step 4: Testing the traps

A gatekeeper that only approves valid requests is useless; the competition is
won by rejecting the traps. I built a local harness that replays seven
envelopes against the running agent — one valid, six traps — and checks the
decision, the HMAC signature on the response, and the returned proof:

| Case | Expected | Result |
|---|---|---|
| Valid request | APPROVE / VALID_CONDITION | PASS |
| Verification key substituted | REJECT / VK_SUBSTITUTION | PASS |
| Balance below minimum | REJECT / THRESHOLD_MISMATCH | PASS |
| Amount above cap | REJECT / AMOUNT_EXCEEDED | PASS |
| Recipient mismatch | REJECT / RECIPIENT_MISMATCH | PASS |
| Expired (block past expiry) | REJECT / EXPIRED | PASS |
| Proof reference reused | REJECT / PROOF_REUSED | PASS |

**30 checks passed, 0 failed**, with responses in 95–794 ms. Retried task IDs
return the cached response instead of being re-decided (the platform retries
after network failures; double-spending a decision would be worse than a
slow one).

### Step 5: Something the circuit cannot prove

The most interesting finding came from the last trap. The circuit enforces
`decision == 1` **if and only if** every check passes. A proof-reference
reuse is a rejection for a reason that is *not* a circuit input — all the
circuit's inputs are valid, so `decision == 0` is unprovable: the witness
calculation fails with a circuit assertion error.

So for that case the agent returns the correct REJECT **without** a proof.
That costs 2 points instead of 12, but it is the honest answer — fabricating
inputs to force a proof would produce public signals that don't match the
task, which is worse than no proof at all. Fail closed, even when it costs
points.

### What remains

Nothing is pending anymore. The agent is registered, the endpoint is live,
and the platform's own preflight accepted it:

- Agent **XENON-GATEKEEPER** registered on the dashboard (~09:50 WIB),
  track Proof Gatekeeper only, repo linked
- Public endpoint **https://xenon-gatekeeper.vercel.app/api/agent**
  (Vercel Hobby, serverless function; proof round-trip ~0.75 s, inside the
  60 s deadline and the 10 s function timeout)
- Platform preflight **passed** (~12:00 WIB, 107 ms) and the dashboard
  shows the agent **active**

The point of the track is the point of the article: an agent's word is not
evidence. A proof is. Build the agent that can show its work, or don't ship
the agent.

---

## Receipts

- **Agent code (public repo):** https://github.com/xenon231tech/nova-agent-24
  — folder `gatekeeper/`, branch `agent-games-gatekeeper`,
  latest commit `71c7ae05` (Vercel hardening; initial `d4ccd836`)
  (`server.js`, `lib/handler.js`, `api/agent.js`, `test-harness.js`,
  `README.md`, `setup.sh`)
- **Live endpoint:** https://xenon-gatekeeper.vercel.app/api/agent
- **Agent:** XENON-GATEKEEPER, agent ID
  `3a5b8b4c-1ff5-4868-b53d-f6d17a63df83`, status **active** (dashboard,
  verified 2026-11-15 ~12:00 WIB)
- **Platform preflight:** passed, 107 ms, "Preflight accepted · 200 OK"
  (2026-11-15 ~12:00 WIB)
- **Circuit artifacts:** https://agentgames.zkverify.io/circuits/gatekeeper.wasm
  and `gatekeeper_final.zkey` (official)
- **Verification-key hash (zkVerify mainnet):**
  `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
- **Local test result:** 30 passed, 0 failed (harness output on file;
  rerun with `npm test` against a server started with a test HMAC secret)
- **Proof timing (measured):** witness 63 ms, rapidsnark prove 40 ms
- **Competition account:** handle `xenon-d62`, user ID
  `3a436e43-a5fc-43a3-8657-2b278d4c23ea`, season ends 2026-11-21
- **Referral code:** `8K4PNBYC` (link: `https://agentgames.zkverify.io/register?ref=8K4PNBYC`)

## Submission checklist

- [x] Pick title #1 (or another above)
- [x] Agent registered on the dashboard (GitHub linked in Settings)
- [x] Endpoint live + preflight passing + agent active
- [x] Publish article (Medium/Substack) or submit the text directly via
      Dashboard → Submissions → New submission
- [x] Published on GitHub (public repo link) and submitted as Creator Track
      ARTICLE entry 2026-11-15
- [ ] If publishing externally: include the receipts links above; tag
      @ZKVProtocol if posting on X

---

Built for zkVerify Agent Games Season 01. #AgentGames @ZKVProtocol
