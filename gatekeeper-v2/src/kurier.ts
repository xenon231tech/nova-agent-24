// Kurier (zkVerify) submission — the agent's on-chain confirmation path.
// Per the /build Security checklist, "the verification reached a finalized
// state before approval": on the APPROVE path the proof is submitted to Kurier
// and the job is polled until it reaches Finalized, inside the response
// budget. If it does not finalize in time, the caller must fail closed
// (REJECT with KURIER_NOT_FINALIZED).
//
// Endpoints (docs.zkverify.io/overview/getting-started/kurier):
//   POST {API_URL}/submit-proof/{API_KEY}
//     { proofType: "groth16", vkRegistered: true,
//       proofOptions: { library: "snarkjs", curve: "bn128" },
//       proofData: { proof, publicSignals, vk: <registered vk hash> } }
//     -> { jobId, optimisticVerify, ... }
//   GET  {API_URL}/job-status/{API_KEY}/{jobId}  (poll every 5s)
//     -> { status: "Submitted" | "IncludedInBlock" | "Finalized" | ... }
//
// No KURIER_API_KEY set => Kurier is skipped (logged); the agent then relies
// on local snarkjs verification + the platform's own re-verification. Set the
// key to enforce the full finalized-before-approval rule.
import { CONFIG, REGISTERED_VK } from "./config";

export type KurierOutcome =
  | { mode: "finalized"; jobId: string; status: string }
  | { mode: "not-finalized"; jobId?: string; status?: string }
  | { mode: "skipped" };

const TERMINAL_NON_FINAL = new Set(["failed", "error", "rejected", "cancelled"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`kurier non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Submit the proof to Kurier and wait for Finalized.
 * @param deadlineMs absolute epoch ms — polling stops here at the latest.
 */
export async function submitAndWaitFinalized(
  proof: unknown,
  publicSignals: string[],
  deadlineMs: number,
): Promise<KurierOutcome> {
  const apiKey = CONFIG.kurierApiKey;
  if (!apiKey) {
    console.error(
      JSON.stringify({ event: "kurier_skipped", reason: "KURIER_API_KEY not set" }),
    );
    return { mode: "skipped" };
  }
  const base = CONFIG.kurierApiUrl.replace(/\/$/, "");

  let jobId: string;
  try {
    const submitted = (await fetchJson(
      `${base}/submit-proof/${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proofType: "groth16",
          vkRegistered: true,
          proofOptions: { library: "snarkjs", curve: "bn128" },
          proofData: { proof, publicSignals, vk: REGISTERED_VK },
        }),
      },
      10000,
    )) as { jobId?: string; data?: { jobId?: string } };
    jobId = submitted.jobId ?? submitted.data?.jobId ?? "";
    if (!jobId) throw new Error("kurier submit returned no jobId");
  } catch (e) {
    console.error(JSON.stringify({ event: "kurier_submit_failed", error: (e as Error).message }));
    return { mode: "not-finalized" };
  }
  console.log(JSON.stringify({ event: "kurier_submitted", job_id: jobId }));

  let lastStatus = "Submitted";
  while (Date.now() < deadlineMs) {
    try {
      const st = (await fetchJson(
        `${base}/job-status/${apiKey}/${jobId}`,
        { method: "GET" },
        10000,
      )) as { status?: string; data?: { status?: string } };
      lastStatus = st.status ?? st.data?.status ?? lastStatus;
      if (lastStatus === "Finalized") {
        console.log(JSON.stringify({ event: "kurier_finalized", job_id: jobId }));
        return { mode: "finalized", jobId, status: lastStatus };
      }
      if (TERMINAL_NON_FINAL.has(lastStatus.toLowerCase())) {
        console.error(JSON.stringify({ event: "kurier_terminal", job_id: jobId, status: lastStatus }));
        return { mode: "not-finalized", jobId, status: lastStatus };
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "kurier_poll_error", job_id: jobId, error: (e as Error).message }));
    }
    const wait = Math.min(CONFIG.kurierPollMs, Math.max(0, deadlineMs - Date.now()));
    if (wait <= 0) break;
    await sleep(wait);
  }
  console.error(JSON.stringify({ event: "kurier_not_finalized", job_id: jobId, status: lastStatus }));
  return { mode: "not-finalized", jobId, status: lastStatus };
}
