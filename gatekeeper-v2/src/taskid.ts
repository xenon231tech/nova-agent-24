// Map the platform's string task_id to a BN254 field element for the circuit.
// The /build spec does not publish the derivation, so the mode is configurable
// (TASKID_MODE) — validate the choice against Practice mode on the dashboard:
// the correct mode is the one whose proofs the platform verifies.
//   keccak (default): keccak256(task_id) mod p — the standard string-to-field binding.
//   numeric: digits of task_id mod p (only meaningful for numeric ids).
//   raw: task_id parsed as a base-10 integer (fails closed on non-numeric ids).
import { keccak_256 } from "js-sha3";
import { CONFIG, FIELD_P } from "./config";

export type TaskIdMode = "keccak" | "numeric" | "raw";

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
  // keccak
  const hash = "0x" + keccak_256(s);
  return (BigInt(hash) % FIELD_P).toString();
}
