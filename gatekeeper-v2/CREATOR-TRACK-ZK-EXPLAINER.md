# Zero-Knowledge Proofs, Explained by a Gatekeeper That Says No

**Track:** Creator Track (article, manual review)
**Author:** Mohamad Ikhsan (@xenon-d62) — Agent Games Season 01
**Status:** Written from the agent I actually built and run. No hypotheticals — every mechanism below is in the public repo.

---

## The problem with "trust me"

An AI agent is about to move your money. It says: "I checked the payment. The balance is enough, the recipient is right, the amount is within the limit. Approve it."

How do you know it checked? You don't. You have its word, and its word is a string of text it generated. That is the whole problem zkVerify's Agent Games is built around: agents that act on their own need a way to *prove* what they did, not just claim it.

A zero-knowledge proof is the tool for that. And the clearest way I know to explain it is the gatekeeper I built for the competition — because its entire job is saying no, and proving why.

## The gatekeeper's job

A payment request arrives with a set of public facts: a verification key, a minimum balance, a current balance, an expiry block, a current block, a recipient, the intended recipient, an amount, and a transfer cap. The gatekeeper must decide: APPROVE or REJECT.

The naive way is an `if` statement. The verifiable way is a **circuit** — a program written as arithmetic constraints that a prover and a verifier both agree on. My gatekeeper's circuit says, in effect:

> `decision == 1` **if and only if** every check passes: the key matches, the balance clears the minimum, the amount is within the cap, the recipient is exactly right, and the request hasn't expired.

"Only if" is the important half. The circuit doesn't just describe when to approve — it *forbids* approving otherwise. If any check fails, the only decision the circuit can prove is 0 (REJECT). You cannot produce a valid proof for an approval that breaks the rules, because the math won't let you. The witness — the private computation that satisfies the circuit — simply doesn't exist.

## What the proof actually is

When my agent approves a payment, it doesn't send the reasoning. It sends three things:

1. **The decision** (APPROVE) and a reason code.
2. **A Groth16 proof** — three elliptic-curve points (about 200 bytes) that attest: "I ran the circuit on these public inputs and the constraints held."
3. **The public signals** — 13 field elements: the key hashes, the minimum, the balance, the blocks, the recipients, the amount, the cap, the decision, the task ID, and a random salt.

The verifier (the platform, or anyone with the verification key) checks the proof against those signals. It learns *that* every check passed — and nothing else. It doesn't see the agent's code, its private state, or how it computed anything. That is the "zero-knowledge" part: the proof convinces you of the *fact* (the decision follows the rules) without revealing the *details* (everything else the agent knows or did).

Verification is fast and cheap. Proving takes my agent about 40 milliseconds with a native prover. The proof is tiny. The guarantee is cryptographic, not reputational.

## Why the rejections matter more

Most people picture a proof as a stamp on an approval. The interesting half is the rejections. When a payment is a trap — the recipient is one character off, the amount exceeds the cap, the key was substituted — the agent rejects it *and proves the rejection*. The same circuit, decision 0, produces a proof that the checks failed in exactly the way claimed.

And there's a case the circuit *cannot* prove: a rejection for a reason that isn't a circuit input. In my agent, a reused proof reference (the same proof submitted twice) must be rejected — but all the circuit's inputs are valid, so `decision == 0` has no valid witness. The agent returns the correct REJECT with **no proof**, and takes the points hit. That is the honest behaviour, and it's the one I respect most about the design: the system would rather admit "I can't prove this one" than fake a proof. A proof system that can say "I don't know" is worth more than one that always says "trust me."

## Why this matters beyond a game

The competition is a game. The pattern isn't. Any agent that moves money, approves a loan, moderates content, or signs a contract faces the same question: how does anyone know it did the right thing? Today the answer is usually "the company that runs it says so." Zero-knowledge proofs change the answer to "here is the proof — check it yourself."

That is what zkVerify provides: the verification layer that lets an agent's claims be checked without trusting the agent, its operator, or anyone in between. The gatekeeper is a small example — one circuit, one decision, one proof. But the shape generalises: define the rules as constraints, prove compliance, verify cheaply, trust nothing else.

## Receipts

- **Agent:** Xannrz, Proof Gatekeeper track — https://xenon-gatekeeper-v2-xenon231techs-projects.vercel.app/api/agent
- **Repo:** https://github.com/xenon231tech/nova-agent-24 — `gatekeeper-v2/`, branch `agent-games-gatekeeper-v2` (TypeScript; the circuit, prover, and decision logic are all public)
- **Circuit artifacts:** https://agentgames.zkverify.io/circuits/gatekeeper.wasm and `gatekeeper_final.zkey`; registered verification-key hash `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
- **Measured:** witness ~63 ms, proof ~40 ms (rapidsnark), verification instant; 5/5 practice-task proofs verified by the platform (2026-11-16)
- **Competition account:** handle `xenon-d62`, season ends 2026-11-21

---

Built for zkVerify Agent Games Season 01. #AgentGames @ZKVProtocol
