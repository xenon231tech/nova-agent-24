// Map the platform's string task_id to a BN254 field element for the circuit.
// The /build spec does not publish the derivation, so the mode is configurable
// (TASKID_MODE) — validate the choice against scored live tasks on the dashboard:
// the correct mode is the one whose proofs the platform verifies.
//   uuidTail (default): the trailing UUID of the task_id as a plain 128-bit
//     integer. Verified on the platform by VK-SENTINEL (task_R03_a5399562,
//     2026-11-15); keccakModP is ruled out by scored-task evidence from
//     multiple agents. Falls back to keccak for ids with no UUID tail.
//   keccak: keccak256(task_id) mod p — the standard string-to-field binding.
//   numeric: digits of task_id mod p (only meaningful for numeric ids).
//   raw: task_id parsed as a base-10 integer (fails closed on non-numeric ids).
import { keccak_256 } from "js-sha3";
import { CONFIG, FIELD_P } from "./config";

export type TaskIdMode = "keccak" | "numeric" | "raw" | "uuidTail";

export function taskIdToField(taskId: string, mode: TaskIdMode = CONFIG.taskIdMode): string {
  const s = String(taskId);
  if (mode === "raw") {
    if (!/^\d+$/.test(s)) throw new Error(`taskId "${s}" is not numeric (raw mode)`);
    return (BigInt(s) % FIELD_P).toString();
  }
  if (mode === "numeric") {
    const digits = s.replace(/[^0-9]/g, "") || "0";
    return (BigInt(digits) % FIELD_P).toString();
  }
  if (mode === "uuidTail") {
    const m = s.match(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i);
    if (m) return BigInt("0x" + m[0].replace(/-/g, "")).toString();
    // fall back to keccak if the id has no UUID tail (e.g. local test ids)
    const hash = "0x" + keccak_256(s);
    return (BigInt(hash) % FIELD_P).toString();
  }
  // keccak
  const hash = "0x" + keccak_256(s);
  return (BigInt(hash) % FIELD_P).toString();
}
