// File-backed idempotency state: proof_tx ownership + cached responses by task.
// On Vercel only /tmp is writable, so STATE_DIR must be /tmp there (the
// Vercel entry sets it before the first request). State is best-effort on
// serverless (per-instance); the platform retries with the same task_id, and
// the in-memory copy covers retries within one warm instance.
import * as fs from "fs";
import * as path from "path";

export interface AgentState {
  /** proof_tx (lowercased) -> task_id that first used it. */
  seenProofTx: Record<string, string>;
  /** task_id -> last response object sent for it. */
  responsesByTask: Record<string, unknown>;
}

function getStateDir(): string {
  if (process.env.VERCEL === "1") return process.env.STATE_DIR || "/tmp";
  return process.env.STATE_DIR || process.cwd();
}

function statePath(): string {
  return path.join(getStateDir(), "state.json");
}

function decisionsPath(): string {
  return path.join(getStateDir(), "decisions.jsonl");
}

let state: AgentState = { seenProofTx: {}, responsesByTask: {} };
let loaded = false;

export function loadState(): AgentState {
  if (loaded) return state;
  loaded = true;
  try {
    if (fs.existsSync(statePath())) {
      state = JSON.parse(fs.readFileSync(statePath(), "utf8")) as AgentState;
      state.seenProofTx = state.seenProofTx || {};
      state.responsesByTask = state.responsesByTask || {};
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "state_load_failed", error: (e as Error).message }));
  }
  return state;
}

export function saveState(): void {
  try {
    const p = statePath();
    fs.writeFileSync(p + ".tmp", JSON.stringify(loadState()));
    fs.renameSync(p + ".tmp", p);
  } catch (e) {
    console.error(JSON.stringify({ event: "state_save_failed", error: (e as Error).message }));
  }
}

export function logDecisionLine(line: string): void {
  try {
    fs.appendFileSync(decisionsPath(), line + "\n");
  } catch {
    /* ignore — logging must never break a response */
  }
}
