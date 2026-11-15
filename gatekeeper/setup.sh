#!/usr/bin/env bash
# Downloads the binary artifacts this agent needs (not committed to git):
#   - gatekeeper.wasm + gatekeeper_final.zkey (official circuit artifacts)
#   - bin/rapidsnark (rapidsnark v0.0.8 prover, linux x86_64)
# Safe to re-run; skips files that already exist. Run automatically by `npm install`
# via the postinstall script, or manually: ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f gatekeeper.wasm ]; then
  echo "downloading gatekeeper.wasm ..."
  curl -sL -o gatekeeper.wasm "https://agentgames.zkverify.io/circuits/gatekeeper.wasm"
fi
if [ ! -f gatekeeper_final.zkey ]; then
  echo "downloading gatekeeper_final.zkey ..."
  curl -sL -o gatekeeper_final.zkey "https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey"
fi
if [ ! -f bin/rapidsnark ]; then
  echo "downloading rapidsnark ..."
  mkdir -p bin
  tmp="$(mktemp -d)"
  curl -sL -o "$tmp/rapidsnark.zip" "https://github.com/iden3/rapidsnark/releases/download/v0.0.8/rapidsnark-linux-x86_64-v0.0.8.zip"
  unzip -o -q "$tmp/rapidsnark.zip" "rapidsnark-linux-x86_64-v0.0.8/bin/prover" -d "$tmp"
  cp "$tmp/rapidsnark-linux-x86_64-v0.0.8/bin/prover" bin/rapidsnark
  chmod +x bin/rapidsnark
  rm -rf "$tmp"
fi
echo "artifacts ready."
ls -la gatekeeper.wasm gatekeeper_final.zkey bin/rapidsnark
