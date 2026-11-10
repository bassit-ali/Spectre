#!/usr/bin/env bash
# Stage SPECTRE Linux payload and create arch tar.gz archives under release/
# Developed by 26 Sig Bn R&D Wing
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
VERSION="${VERSION:-1.1.0}"
PAYLOAD="${RELEASE}/linux/payload-${ARCH}"
OUT_TGZ="${RELEASE}/spectre-linux-${ARCH}.tar.gz"

echo "==> SPECTRE Linux package (${ARCH})"
echo "    Developed by 26 Sig Bn R&D Wing"
echo "    Root: ${ROOT}"

if [[ "${SKIP_BUILD}" -eq 0 ]]; then
  echo "==> Building web"
  (cd "${ROOT}/web" && { [[ -d node_modules ]] || npm install; } && npm run build)
  echo "==> Building server"
  (cd "${ROOT}" && npm run server:build)
fi

if [[ ! -f "${ROOT}/server/dist/src/index.js" ]]; then
  echo "Missing server/dist — build first" >&2
  exit 1
fi
if [[ ! -f "${ROOT}/web/dist/index.html" ]]; then
  echo "Missing web/dist — build first" >&2
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
  "description": "SPECTRE local web service — Developed by 26 Sig Bn R&D Wing",
  "main": "server/dist/src/index.js",
  "dependencies": {
    "@fastify/static": "^10.1.10",
    "fastify": "^5.12.8",
    "serialport": "^12.0.0",
    "ws": "^8.22.2"
  }
}
EOF

echo "==> npm install --omit=dev"
(cd "${PAYLOAD}" && npm install --omit=dev --no-audit --no-fund)

# serialport ships native bindings; document cross-arch caveat
NOTE="${PAYLOAD}/ARCH.txt"
{
  echo "SPECTRE Linux payload arch label: ${ARCH}"
  echo "Build host: $(uname -m) ($(uname -s))"
  echo "Developed by 26 Sig Bn R&D Wing"
  echo
  echo "If this archive was produced on a different CPU architecture than the"
  echo "target, re-run npm install --omit=dev on the target (or rebuild with"
  echo "ARCH matching the host) so serialport native bindings match."
  echo
  echo "Cross-build note: arm64 packages built on x64 (or vice versa) need a"
  echo "native rebuild on-device: cd /opt/spectre && npm rebuild serialport"
} > "${NOTE}"

cat > "${PAYLOAD}/README.txt" <<EOF
SPECTRE — Linux (${ARCH})
Developed by 26 Sig Bn R&D Wing

One-command install:
  sudo ./install.sh

Installs to /opt/spectre, enables systemd unit spectre.service, starts service.
Open: http://127.0.0.1:9000/

Prerequisite: Node.js LTS on PATH (or bundle runtime/).
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
  echo "NOTE: ARCH=${ARCH} differs from host $(host_arch) — native modules may need rebuild on target."
fi
