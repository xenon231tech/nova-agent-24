// HMAC-SHA256 signing over RAW request/response bodies.
// Verified BEFORE parsing JSON on inbound requests (spec §02), and applied
// to every outbound response via the x-agent-games-signature header.
import * as crypto from "crypto";
import { CONFIG } from "./config";

export function hmacHex(secret: string, rawBody: Buffer): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * Verify the x-agent-games-signature header against the raw body.
 * Accepts "sha256=<hex>" (platform format) and bare "<hex>"; a base64
 * encoding of the hex is also tolerated, matching observed platform traffic.
 * Returns false on any mismatch — the caller must reject (401) before parsing.
 */
export function verifySignature(rawBody: Buffer, headerValue: string | undefined | null): boolean {
  const secret = CONFIG.hmacSecret;
  if (!secret || !headerValue) return false;
  let provided = headerValue.trim();
  if (provided.toLowerCase().startsWith("sha256=")) provided = provided.slice(7);
  const expectedHex = hmacHex(secret, rawBody);
  const candidates = [provided.toLowerCase()];
  try {
    candidates.push(Buffer.from(provided, "base64").toString("hex"));
  } catch {
    /* not base64 — ignore */
  }
  return candidates.some((c) => timingSafeEqualHex(c, expectedHex));
}

/** Sign a raw response body. Format follows SIGNATURE_FORMAT. */
export function signBody(rawBody: Buffer | string): string {
  const hex = hmacHex(CONFIG.hmacSecret, Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody));
  return CONFIG.signatureFormat === "bare" ? hex : `sha256=${hex}`;
}
