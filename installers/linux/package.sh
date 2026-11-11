#!/usr/bin/env bash
# Stage SPECTRE Linux payload and create arch tar.gz archives under release/
# 
#
# Usage:
#   ./installers/linux/package.sh              # build + package host arch
#   ./installers/linux/package.sh --skip-build # package only
#   ARCH=arm64 ./installers/linux/package.sh   # label/output as arm64 (same tree if no cross-build)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RELEASE="${ROOT}/release"
SKIP_BUILD=0

for arg in "$@"; do
  case "${arg}" in
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help)
      echo "Usage: $0 [--skip-build]"
      exit 0
      ;;
  esac
done

host_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) uname -m ;;
  esac
}

ARCH="${ARCH:-$(host_arch)}"
VERSION="${VERSION:-1.1.3}"
PAYLOAD="${RELEASE}/linux/payload-${ARCH}"
OUT_TGZ="${RELEASE}/spectre-linux-${ARCH}.tar.gz"

echo "==> SPECTRE Linux package (${ARCH})"
echo "    Root: ${ROOT}"

if [[ "${SKIP_BUILD}" -eq 0 ]]; then
  echo "==> Building web"
  (cd "${ROOT}/web" && { [[ -d node_modules ]] || npm install; } && npm run build)
  echo "==> Building server"
  (cd "${ROOT}" && npm run server:build)
fi

if [[ ! -f "${ROOT}/server/dist/src/index.js" ]]; then
  echo "Missing server/dist â€” build first" >&2
  exit 1
fi
if [[ ! -f "${ROOT}/web/dist/index.html" ]]; then
  echo "Missing web/dist â€” build first" >&2
  exit 1
fi

rm -rf "${PAYLOAD}"
mkdir -p "${PAYLOAD}/server" "${PAYLOAD}/web"

cp -a "${ROOT}/server/dist" "${PAYLOAD}/server/dist"
cp -a "${ROOT}/web/dist" "${PAYLOAD}/web/dist"
cp "${SCRIPT_DIR}/spectre.sh" "${PAYLOAD}/spectre.sh"
cp "${SCRIPT_DIR}/spectre.service" "${PAYLOAD}/spectre.service"
cp "${SCRIPT_DIR}/install.sh" "${PAYLOAD}/install.sh"
chmod +x "${PAYLOAD}/spectre.sh" "${PAYLOAD}/install.sh"

# Stage pip-shell sources (Electron installed on-target by install.sh)
mkdir -p "${PAYLOAD}/pip-shell"
cp "${ROOT}/pip-shell/main.js" "${PAYLOAD}/pip-shell/main.js"
cp "${ROOT}/pip-shell/preload.js" "${PAYLOAD}/pip-shell/preload.js"
cat > "${PAYLOAD}/pip-shell/package.json" <<'EOF'
{
  "name": "spectre-pip-shell",
  "version": "1.0.0",
  "private": true,
  "description": "SPECTRE always-on-top widget overlay",
  "main": "main.js",
  "dependencies": {
    "electron": "^33.2.0"
  }
}
EOF

cat > "${PAYLOAD}/package.json" <<EOF
{
  "name": "spectre",
  "version": "${VERSION}",
  "private": true,
  "description": "SPECTRE local web service",
  "main": "server/dist/src/index.js",
  "dependencies": {
    "@fastify/static": "^10.1.10",
    "fastify": "^5.12.8",
    "serialport": "^12.0.0",
    "ws": "^8.22.2"
  }
}
EOF

NODE_VER="${NODE_VERSION:-20.18.2}"
NODE_NAME="node-v${NODE_VER}-linux-${ARCH}"
NODE_URL="https://nodejs.org/dist/v${NODE_VER}/${NODE_NAME}.tar.gz"
NODE_CACHE="${HOME}/.cache/spectre-node-dist"
mkdir -p "${NODE_CACHE}" "${PAYLOAD}/runtime"
NODE_TGZ="${NODE_CACHE}/${NODE_NAME}.tar.gz"
if [[ ! -f "${PAYLOAD}/runtime/bin/node" ]]; then
  echo "==> Bundling Node ${NODE_VER} (${ARCH})"
  if [[ ! -f "${NODE_TGZ}" ]]; then
    curl -fsSL "${NODE_URL}" -o "${NODE_TGZ}"
  fi
  tar -xzf "${NODE_TGZ}" -C "${PAYLOAD}/runtime" --strip-components=1
fi

echo "==> npm install --omit=dev"
(cd "${PAYLOAD}" && npm install --omit=dev --no-audit --no-fund)

NOTE="${PAYLOAD}/ARCH.txt"
{
  echo "SPECTRE Linux payload arch label: ${ARCH}"
  echo "Build host: $(uname -m) ($(uname -s))"
  echo "Bundled Node: runtime/bin/node (no system Node required)"
  echo
  echo "If serialport fails: PATH=\"\$PWD/runtime/bin:\$PATH\" npm rebuild serialport"
} > "${NOTE}"

cat > "${PAYLOAD}/README.txt" <<EOF
SPECTRE — Linux (${ARCH})

One-command install (offline-capable):
  sudo ./install.sh

Installs to /opt/spectre, enables systemd unit spectre.service, starts service.
Includes bundled Node under runtime/ — no separate Node.js install.
Open: http://127.0.0.1:9000/
EOF

mkdir -p "${RELEASE}"
rm -f "${OUT_TGZ}"
# Tar with a stable top-level folder name
STAGE_PARENT="${RELEASE}/linux/_stage"
rm -rf "${STAGE_PARENT}"
mkdir -p "${STAGE_PARENT}"
cp -a "${PAYLOAD}" "${STAGE_PARENT}/spectre"
# Also drop a symlink-friendly copy of install at top for convenience after extract
(
  cd "${STAGE_PARENT}"
  tar -czf "${OUT_TGZ}" spectre
)
rm -rf "${STAGE_PARENT}"

# Convenience copy of generic payload path
mkdir -p "${RELEASE}/linux"
rm -rf "${RELEASE}/linux/payload"
cp -a "${PAYLOAD}" "${RELEASE}/linux/payload"

echo
echo "Created: ${OUT_TGZ}"
echo "Payload: ${PAYLOAD}"
if [[ "${ARCH}" != "$(host_arch)" ]]; then
  echo "NOTE: ARCH=${ARCH} differs from host $(host_arch) â€” native modules may need rebuild on target."
fi
