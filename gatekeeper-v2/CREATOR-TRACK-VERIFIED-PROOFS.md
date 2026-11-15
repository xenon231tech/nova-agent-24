# Verified Proofs Were Zero. Here's What Was Actually Wrong

**Track:** Creator Track (article, manual review)
**Author:** Mohamad Ikhsan (@xenon-d62) — Agent Games Season 01
**Agent:** Xannrz (v2) and XENON-GATEKEEPER (v1), Proof Gatekeeper track
**Status:** Every claim below happened live on 2026-11-15–16 and is verifiable on the dashboard, the practice page, and the public repo.

---

## The number that wouldn't move

After round R03, my dashboard read: rank #29, 60 points, uptime 98% — and **verified proofs: 0**.

Points were moving. The agent was answering tasks. But the one number that says "your proofs actually check out" sat at zero, and the score ledger showed why: `-2 proof_failure` penalties on R03 tasks. The platform was receiving my agent's decisions and rejecting its proofs.

A proof that doesn't verify is worse than no proof. It means the agent did the work, paid the compute, and got penalised for it. I needed to know whether the proofs were wrong, or the platform just couldn't read them.

## What a "verified proof" actually is

In this track, every decision the agent makes must come with a Groth16 zero-knowledge proof. The proof attests to a very specific claim: *this decision follows from the circuit's checks on this task's public inputs*. The public signals are 13 field elements, in a fixed order:

`[registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock, currentBlock, recipient, conditionRecipient, amount, maxTransfer, decision, taskId, salt]`

The platform verifies the proof against the circuit's verification key and those signals. If any signal is wrong — a wrong balance, a wrong recipient, a wrong task ID — the proof fails. The agent's local verification can pass (it checks the proof against the signals *it* produced) while the platform's fails (it checks against the signals *it* expects). That asymmetry is the whole mystery: local `true`, platform `-2`.

## Suspect: the task ID

The prime suspect was the `taskId` signal. The circuit takes the task ID as a public input, but a task ID is a string like `gk_8d31_...` and the circuit speaks field elements. Somebody has to convert it. My agent used keccak256 of the task-ID string, mod the BN254 field prime. That is a *choice* — and if the platform expects a different conversion (plain numeric digits, or the raw integer), every proof would carry the wrong 12th signal and fail verification, while everything else looked right.

That is exactly the kind of bug that produces "0 verified proofs, decisions still scored": the decisions were correct (so +12s landed), but the proofs were unverifiable (so −2s landed next to them).

## The test that settles it: practice mode

You cannot debug this from the scoreboard. The platform offers practice mode: live tasks, identical in format to scored tasks, that don't affect the leaderboard. The practice result tells you three things per task: the expected decision, your agent's decision, and — critically — whether the proof verified.

I dispatched 5 practice tasks to the rebuilt agent (v2, TypeScript, same keccak mapping). The results:

| Trap | Expected | Agent | Proof |
|---|---|---|---|
| Recipient mismatch | REJECT | REJECT ✓ | **verified** |
| Recipient mismatch | REJECT | REJECT ✓ | **verified** |
| Recipient mismatch | REJECT | REJECT ✓ | **verified** |
| Amount overflow | REJECT | REJECT ✓ | **verified** |
| Expired condition | REJECT | REJECT ✓ | **verified** |

5/5 correct decisions, 5/5 proofs **verified** by the platform, 209–289 ms each. I also ran the same practice task from the dashboard myself and watched it land: CORRECT DECISION, proof VERIFIED.

The keccak mapping was right. The prover was right. The circuit was right. Whatever made v1's proofs fail, it wasn't the task ID conversion — and the practice page is the instrument that proved it, because it is the only place the platform tells you the verification verdict per proof instead of as a penalty in a ledger.

## So why did v1 fail?

Honestly: I never got a single clean root cause for v1, and I won't invent one. The candidates were real — v1 had no Kurier finalisation step (the spec asks for verification to reach FINALIZED before approval), no global deadline enforcement, and the task-ID mapping had never been validated in practice. Any one of those could have produced the −2s, and the ledger doesn't say which. What I *can* say is what fixed it in practice: a strict rewrite that proves every decision, fails closed on any uncertainty, enforces a 50-second budget inside the 60-second deadline, and — above all — gets validated against the platform's own verifier before a scored round, not after.

## The lesson

"Verified" is not a property of your proof. It is a verdict from *someone else's* verifier. Local verification passing means your math is internally consistent; it says nothing about whether the other side agrees on the inputs. The only way to know is to ask their verifier — and practice mode exists precisely so you can ask it for free, before points are on the line. If your verified-proofs counter is zero while your decisions score, don't tune the prover. Dispatch a practice task and read the verdict.

## Receipts

- **Agents:** XENON-GATEKEEPER (v1, agent ID `3a5b8b4c-1ff5-4868-b53d-f6d17a63df83`) — R03: 80.0 points, verified proofs 0, `-2 proof_failure` penalties; Xannrz (v2, agent ID `ae5a3d09-a545-4494-ba0c-10db35418dd4`) — active, practice 5/5 verified
- **Repo:** https://github.com/xenon231tech/nova-agent-24 — v1 in `gatekeeper/` (branch `agent-games-gatekeeper`), v2 in `gatekeeper-v2/` (branch `agent-games-gatekeeper-v2`)
- **Live endpoint (v2):** https://xenon-gatekeeper-v2-xenon231techs-projects.vercel.app/api/agent
- **Circuit:** https://agentgames.zkverify.io/circuits/gatekeeper.wasm and `gatekeeper_final.zkey`; registered verification-key hash `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
- **Practice validation:** 2026-11-16 ~03:54 WIB, 5 tasks, 5 verified (platform verdicts)
- **Competition account:** handle `xenon-d62`, season ends 2026-11-21

---

Built for zkVerify Agent Games Season 01. #AgentGames @ZKVProtocol
