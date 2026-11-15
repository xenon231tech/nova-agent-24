// Standalone HTTP server for local dev / self-hosting.
// Thin wrapper around src/handler.ts. Listens on $PORT (default 3000).
// The same core also runs as a Vercel serverless function via api/agent.ts.
import * as http from "http";
import { CONFIG, assertHmacSecret } from "./config";
import { processRequest } from "./handler";

assertHmacSecret();

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "xenon-gatekeeper-v2", version: "v2" }));
    return;
  }
  if (req.method !== "POST" || (req.url !== "/agent" && req.url !== "/")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  // Diagnostic log: path + signature-header SHAPE only (never the value).
  const sigHdrRaw = req.headers["x-agent-games-signature"];
  const sigHdr = Array.isArray(sigHdrRaw) ? sigHdrRaw[0] || "" : sigHdrRaw || "";
  console.log(
    JSON.stringify({
      event: "request",
      method: req.method,
      url: req.url,
      sig_present: !!sigHdr,
      sig_prefix: sigHdr.startsWith("sha256=")
        ? "sha256="
        : sigHdr.length === 64
          ? "bare-hex?"
          : "other",
      sig_len: sigHdr.length,
      ua: (req.headers["user-agent"] || "").slice(0, 60),
    }),
  );

  const chunks: Buffer[] = [];
  let tooLarge = false;
  req.on("data", (c: Buffer) => {
    if (tooLarge) return;
    chunks.push(c);
    if (Buffer.concat(chunks).length > 1024 * 1024) {
      tooLarge = true;
      req.destroy();
    }
  });
  req.on("end", async () => {
    if (tooLarge) return;
    const rawBody = Buffer.concat(chunks);
    const result = await processRequest(rawBody, req.headers["x-agent-games-signature"] as string | undefined);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (result.signature) headers["x-agent-games-signature"] = result.signature;
    res.writeHead(result.status, headers);
    res.end(result.body);
  });
});

server.listen(CONFIG.port, "0.0.0.0", () => {
  console.log(
    `xenon-gatekeeper-v2 listening on :${CONFIG.port} (taskid=${CONFIG.taskIdMode}, sig=${CONFIG.signatureFormat}, kurier=${CONFIG.kurierApiKey ? "on" : "off"})`,
  );
});
