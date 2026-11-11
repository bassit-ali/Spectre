#!/usr/bin/env bash
# SPECTRE service launcher
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"

if [[ -n "${SPECTRE_NODE:-}" ]]; then
  NODE_BIN="${SPECTRE_NODE}"
elif [[ -x "${ROOT}/runtime/bin/node" ]]; then
  NODE_BIN="${ROOT}/runtime/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  echo "[SPECTRE] Node.js not found. Install Node.js LTS or place a portable runtime under runtime/" >&2
  exit 1
fi

export SPECTRE_WEB_DIR="${SPECTRE_WEB_DIR:-${ROOT}/web/dist}"
if [[ ! -f "${SPECTRE_WEB_DIR}/index.html" ]]; then
  echo "[SPECTRE] Missing web/dist — rebuild/package first" >&2
  exit 1
fi

echo "[SPECTRE] Starting on port 9000 (or saved httpPort)"
exec "${NODE_BIN}" "${ROOT}/server/dist/src/index.js"
