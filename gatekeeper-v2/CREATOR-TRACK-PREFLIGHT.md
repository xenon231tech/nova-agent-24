# The Preflight That Lied: A Signature Prefix Broke My Agent for Two Hours

**Track:** Creator Track (article, manual review)
**Author:** Mohamad Ikhsan (@xenon-d62) — Agent Games Season 01
**Agent:** Xannrz, Proof Gatekeeper track
**Status:** Every claim below happened live on 2026-11-16, ~03:35–03:50 WIB, and is verifiable on the dashboard and the public repo.

---

## The symptom

My agent Xannrz was registered, deployed, and healthy by every test I could run myself. Health check: 200. Signed preflight from my own machine: `{"ok":true,"protocolVersion":"v1"}`, signature verified byte-for-byte. Signed task: APPROVE with a Groth16 proof and 13 public signals.

Then I clicked **Run preflight** on the dashboard. It failed. Three times.

> **FAILED (protocol)** — "The endpoint must return signed protocol-v1 JSON."

My endpoint *was* returning signed protocol-v1 JSON. I had just watched it do exactly that. So either the platform was wrong, or my test was lying to me. It was the second one — but not in the way I expected.

## Suspect #1: the secret

The obvious suspect was the HMAC secret. The platform signs task requests with it and verifies response signatures against it. If my deployed secret didn't match the platform's, every platform request would fail authentication.

I rotated the secret from the dashboard and redeployed with the fresh one. My own signed test passed again (of course — I was signing with the same secret I deployed). The platform preflight failed again.

That ruled out the secret as the *only* cause, but it taught me something important: **a test that uses the same secret on both sides can never catch a secret mismatch.** My test proved the server and my test client agreed. It said nothing about the platform.

## Suspect #2: the platform doesn't sign its preflight

I read my handler. It verified the HMAC on *every* request — including preflight — and returned 401 on anything unsigned. So I sent an unsigned preflight to my own endpoint. It 401'd.

Then I remembered: the dashboard's preflight is a diagnostic the platform runs, not a scored task. There is no reason for it to carry a signature — and the spec's preflight description never says the request is signed. It only says the *response* must be signed.

I changed the handler: preflight is answered (signed) whether or not the request carries a signature. Scored tasks still require a valid signature — fail closed where it matters, answer the liveness check where it doesn't. Local harness: 37/37. Deployed. Platform preflight: still failed.

So the unsigned request was real, but it wasn't the whole story either.

## The actual bug: one prefix

I needed a control. The old agent, XENON-GATEKEEPER (v1), had passed the platform's preflight days earlier. Same platform, same protocol, same kind of endpoint. I ran the platform's preflight against v1: **passed**. Then I compared v1's and v2's preflight responses byte by byte.

Bodies: identical — `{"ok":true,"protocolVersion":"v1"}`. Content-Type: identical. The signature headers:

- v1: `db0741cdbfc4f505ce08f7265caf2f08fd4545944ca21c33cc138ead810235e2`
- v2: `sha256=3f2b60ae8f4822c575a3544a5441fdfaa0942c3ebc4eaa153c59bad0819cedfa`

v1 sends **bare hex**. v2 sent `sha256=<hex>`. The platform verifies the response signature against raw hex — it does not strip the prefix. My signature was cryptographically correct and the platform still rejected it, because the *format* didn't match what it compared against.

The fix was one environment variable: `SIGNATURE_FORMAT=bare`. Redeploy, re-test. The platform's own preflight: **ok, 98 ms**. Then, because I had once seen a secret value in a log, I rotated the secret one final time and re-verified: still ok.

## What I actually learned

1. **Diff the bytes, not the idea.** "Signed protocol-v1 JSON" was true in both cases. The failure was in six characters of header prefix that no amount of re-reading the spec would have shown me — only comparing a working response against a failing one did.
2. **A control beats a theory.** I had three theories (secret, unsigned request, format). Only the v1 control test — same platform, known-good agent — separated them. Without it I would still be rotating secrets.
3. **Your own tests share your assumptions.** My signed test passed because it used my secret, my format, my client. The platform is a different verifier with different defaults. The only test that matters is the platform's own.
4. **Liveness checks and scored decisions are different things.** Answering an unsigned preflight is safe because the authentication is the *signed response*, which the platform verifies. Requiring a signature on a task is necessary because the decision moves points. Same endpoint, two different trust rules — and getting that distinction right is the whole job of a gatekeeper.

## Receipts

- **Agent:** Xannrz, agent ID `ae5a3d09-a545-4494-ba0c-10db35418dd4`, Proof Gatekeeper track, status active
- **Endpoint:** https://xenon-gatekeeper-v2-xenon231techs-projects.vercel.app/api/agent
- **Repo:** https://github.com/xenon231tech/nova-agent-24 — folder `gatekeeper-v2/`, branch `agent-games-gatekeeper-v2` (TypeScript rewrite; the fix is in `src/handler.ts` and `src/config.ts`)
- **Platform preflight after the fix:** ok, 98 ms (verified with the platform's own diagnostic, 2026-11-16 ~03:50 WIB)
- **Practice validation after the fix:** 5 live practice tasks, all correct decisions, all proofs **verified** by the platform (recipient mismatch ×3, amount overflow, expired condition; 209–289 ms each)
- **Competition account:** handle `xenon-d62`, season ends 2026-11-21

---

Built for zkVerify Agent Games Season 01. #AgentGames @ZKVProtocol
