#!/usr/bin/env bash
# Fetch build-time binary artifacts from their official sources and verify
# SHA-256. Binaries are NOT committed to git — they are downloaded here so the
# repository stays text-only (required by the GitHub snapshot push).
# Idempotent: files already present with a matching hash are skipped.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/circuits" "$ROOT/bin"

WASM_SHA="be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f"
ZKEY_SHA="adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d"
RAPIDSNARK_ZIP_SHA="2ec59e3aa5ff498e862d60b3b7abdcd094ea484271750ec1ea14fb7c1305e423"

sha_ok() { # file expected-sha
  [ -f "$1" ] && [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$2" ]
}

if sha_ok "$ROOT/circuits/gatekeeper.wasm" "$WASM_SHA"; then
  echo "gatekeeper.wasm: already present, hash ok"
else
  echo "downloading gatekeeper.wasm ..."
  curl -fsSL --max-time 120 "https://agentgames.zkverify.io/circuits/gatekeeper.wasm" -o "$ROOT/circuits/gatekeeper.wasm"
  sha_ok "$ROOT/circuits/gatekeeper.wasm" "$WASM_SHA" || { echo "SHA MISMATCH gatekeeper.wasm" >&2; exit 1; }
fi

if sha_ok "$ROOT/circuits/gatekeeper_final.zkey" "$ZKEY_SHA"; then
  echo "gatekeeper_final.zkey: already present, hash ok"
else
  echo "downloading gatekeeper_final.zkey ..."
  curl -fsSL --max-time 120 "https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey" -o "$ROOT/circuits/gatekeeper_final.zkey"
  sha_ok "$ROOT/circuits/gatekeeper_final.zkey" "$ZKEY_SHA" || { echo "SHA MISMATCH gatekeeper_final.zkey" >&2; exit 1; }
fi

if [ -x "$ROOT/bin/rapidsnark" ]; then
  echo "bin/rapidsnark: already present"
else
  echo "downloading rapidsnark ..."
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL --max-time 180 "https://github.com/iden3/rapidsnark/releases/download/v0.0.8/rapidsnark-linux-x86_64-v0.0.8.zip" -o "$TMP/rapidsnark.zip"
  sha_ok "$TMP/rapidsnark.zip" "$RAPIDSNARK_ZIP_SHA" || { echo "SHA MISMATCH rapidsnark.zip" >&2; exit 1; }
  unzip -o -q "$TMP/rapidsnark.zip" -d "$TMP"
  cp "$TMP/rapidsnark-linux-x86_64-v0.0.8/bin/prover" "$ROOT/bin/rapidsnark"
  chmod +x "$ROOT/bin/rapidsnark"
fi

# verification_key.json is committed text; regenerate it if somehow missing.
if [ ! -f "$ROOT/circuits/verification_key.json" ]; then
  echo "exporting verification_key.json from zkey ..."
  node -e "require('snarkjs').zkey.exportVerificationKey(require('fs').readFileSync('$ROOT/circuits/gatekeeper_final.zkey'), require('fs').createWriteStream('$ROOT/circuits/verification_key.json'))" 2>/dev/null || \
  npx snarkjs zkey export verificationkey "$ROOT/circuits/gatekeeper_final.zkey" "$ROOT/circuits/verification_key.json"
fi

echo "artifacts ok"
ls -la "$ROOT/circuits" "$ROOT/bin"
