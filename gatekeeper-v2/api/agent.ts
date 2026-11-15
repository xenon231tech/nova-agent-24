// Vercel serverless function for the xenon-gatekeeper-v2 Proof Gatekeeper.
// Serves POST /api/agent (the Agent Games endpoint). The platform POSTs task
// envelopes here; the shared core in ../src/handler.ts verifies the HMAC,
// decides, generates the Groth16 proof, waits for Kurier Finalized on the
// APPROVE path, and returns a signed response.
//
// Vercel Node functions use the plain Node http.ServerResponse API
// (writeHead / end) — NOT Express-style res.status().json().
//
// bodyParser must stay off: the HMAC is verified over the RAW request body.
import type { VercelRequest, VercelResponse } from "./vercel-types";
import { processRequest } from "../src/handler";

// Vercel functions are read-only except /tmp: keep the idempotency state
// (state.json / decisions.jsonl) there.
if (process.env.VERCEL === "1") {
  process.env.STATE_DIR = process.env.STATE_DIR || "/tmp";
}

function send(res: VercelResponse, status: number, body: string, signature: string | null): void {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature) headers["x-agent-games-signature"] = signature;
  res.writeHead(status, headers);
  res.end(body);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === "GET") {
    send(res, 200, JSON.stringify({ ok: true, service: "xenon-gatekeeper-v2", version: "v2" }), null);
    return;
  }
  if (req.method !== "POST") {
    send(res, 404, JSON.stringify({ error: "not found" }), null);
    return;
  }
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 1024 * 1024) {
        send(res, 413, JSON.stringify({ error: "body too large" }), null);
        return;
      }
    }
  } catch {
    send(res, 400, JSON.stringify({ error: "unreadable body" }), null);
    return;
  }
  const rawBody = Buffer.concat(chunks);
  const result = await processRequest(rawBody, req.headers["x-agent-games-signature"] as string | undefined);
  send(res, result.status, result.body, result.signature);
}

export const config = { api: { bodyParser: false } };
