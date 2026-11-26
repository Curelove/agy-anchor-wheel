#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for cand in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.local/share/mise/shims/node" \
    "$HOME/.asdf/shims/node"; do
    if [ -x "$cand" ]; then
      NODE_BIN="$cand"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_BIN="$(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -n 1 || true)"
fi

if [ -z "$NODE_BIN" ] && [ -d "$HOME/.local/share/fnm/node-versions" ]; then
  NODE_BIN="$(ls -1d "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node 2>/dev/null | sort -V | tail -n 1 || true)"
fi

if [ -z "$NODE_BIN" ] && [ -d "$HOME/Library/Application Support/fnm/node-versions" ]; then
  NODE_BIN="$(ls -1d "$HOME/Library/Application Support/fnm/node-versions"/*/installation/bin/node 2>/dev/null | sort -V | tail -n 1 || true)"
fi

if [ -z "$NODE_BIN" ]; then
  echo "[AnchorWheel] Node.js 22+ not found. Please install Node.js 22+ (22.5+ recommended for SQLite preview) and retry." >&2
  exit 1
fi

"$NODE_BIN" "$SCRIPT_DIR/scripts/install-plugin.mjs"
