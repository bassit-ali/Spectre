#!/usr/bin/env bash
# SPECTRE one-command Linux installer (x86_64 / aarch64)
#
# Usage (from extracted package or repo installers/linux with staged payload):
#   sudo ./install.sh
#   sudo ./install.sh /path/to/payload
set -euo pipefail

PRODUCT="SPECTRE"
TAGLINE="SPECTRE pan/tilt pedestal controller"
INSTALL_DIR="/opt/spectre"
UNIT_NAME="spectre.service"
URL="http://127.0.0.1:9000/"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo $0 $*" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

detect_arch() {
  local m
  m="$(uname -m)"
  case "${m}" in
    x86_64|amd64) echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) echo "${m}" ;;
  esac
}

ARCH="$(detect_arch)"
echo "==> ${PRODUCT} install (${ARCH})"
echo "    ${TAGLINE}"

PAYLOAD="${1:-}"
if [[ -z "${PAYLOAD}" ]]; then
  for c in \
    "${SCRIPT_DIR}" \
    "${SCRIPT_DIR}/payload" \
    "${SCRIPT_DIR}/../../release/linux/payload" \
    "${SCRIPT_DIR}/../../release/linux/payload-${ARCH}"
  do
    if [[ -f "${c}/server/dist/src/index.js" ]]; then
      PAYLOAD="${c}"
      break
    fi
  done
fi

if [[ -z "${PAYLOAD}" || ! -f "${PAYLOAD}/server/dist/src/index.js" ]]; then
  echo "SPECTRE payload not found (need server/dist/src/index.js)." >&2
  echo "Pass the payload directory: sudo ./install.sh /path/to/payload" >&2
  exit 1
fi

PAYLOAD="$(cd "${PAYLOAD}" && pwd)"
echo "    From: ${PAYLOAD}"
echo "    To:   ${INSTALL_DIR}"

if [[ ! -f "${PAYLOAD}/runtime/bin/node" ]] && ! command -v node >/dev/null 2>&1; then
  echo "ERROR: No bundled runtime/bin/node and no system node on PATH." >&2
  echo "This package should include runtime/ — re-download the release archive." >&2
  exit 1
fi

systemctl stop "${UNIT_NAME}" 2>/dev/null || true

mkdir -p "${INSTALL_DIR}"
# Prefer rsync; fall back to cp
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.git' \
    --exclude 'install.sh' \
    "${PAYLOAD}/" "${INSTALL_DIR}/"
else
  find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -a "${PAYLOAD}/." "${INSTALL_DIR}/"
fi

# Ensure launcher + unit from installer kit if missing in payload
if [[ ! -f "${INSTALL_DIR}/spectre.sh" ]]; then
  if [[ -f "${SCRIPT_DIR}/spectre.sh" ]]; then
    cp "${SCRIPT_DIR}/spectre.sh" "${INSTALL_DIR}/spectre.sh"
  fi
fi

# Packaging on Windows can drop +x bits — restore offline runtime executables.
chmod +x "${INSTALL_DIR}/spectre.sh" 2>/dev/null || true
if [[ -d "${INSTALL_DIR}/runtime/bin" ]]; then
  chmod -R a+rx "${INSTALL_DIR}/runtime/bin" 2>/dev/null || true
fi
ELECTRON_BIN="${INSTALL_DIR}/pip-shell/node_modules/electron/dist/electron"
if [[ -f "${ELECTRON_BIN}" ]]; then
  chmod +x "${ELECTRON_BIN}" 2>/dev/null || true
  # chrome-sandbox needs root ownership + setuid when present; ignore if missing
  if [[ -f "${INSTALL_DIR}/pip-shell/node_modules/electron/dist/chrome-sandbox" ]]; then
    chown root:root "${INSTALL_DIR}/pip-shell/node_modules/electron/dist/chrome-sandbox" 2>/dev/null || true
    chmod 4755 "${INSTALL_DIR}/pip-shell/node_modules/electron/dist/chrome-sandbox" 2>/dev/null || true
  fi
  echo "    Electron overlay binary present (offline)"
else
  echo "WARN: Electron binary not in package — browser widget still works at ${URL}widget.html" >&2
fi

# Prefer system unit for boot-enable; fall back to user unit instructions
UNIT_SRC="${SCRIPT_DIR}/spectre.service"
if [[ -f "${INSTALL_DIR}/spectre.service" ]]; then
  UNIT_SRC="${INSTALL_DIR}/spectre.service"
fi
install -m 0644 "${UNIT_SRC}" "/etc/systemd/system/${UNIT_NAME}"

# udev + dialout for common USB-serial adapters
if getent group dialout >/dev/null 2>&1; then
  # Add invoking user (SUDO_USER) to dialout when available
  if [[ -n "${SUDO_USER:-}" ]]; then
    usermod -aG dialout "${SUDO_USER}" || true
  fi
fi
RULE='/etc/udev/rules.d/99-spectre-usbserial.rules'
cat > "${RULE}" <<'EOF'
# SPECTRE — USB-serial adapters (CH340 / FTDI / CP210x)
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", MODE="0660", GROUP="dialout"
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", MODE="0660", GROUP="dialout"
SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", MODE="0660", GROUP="dialout"
EOF
udevadm control --reload-rules 2>/dev/null || true
udevadm trigger 2>/dev/null || true

printf '%s\n' "${PRODUCT}" "${TAGLINE}" "Local web service: available on port 9000 (or saved httpPort)" > "${INSTALL_DIR}/BRANDING.txt"

systemctl daemon-reload
systemctl enable "${UNIT_NAME}"
systemctl restart "${UNIT_NAME}" || systemctl start "${UNIT_NAME}"

sleep 1
systemctl --no-pager --full status "${UNIT_NAME}" || true

echo
echo "Installed."
echo "  Service: systemctl status ${UNIT_NAME}"
echo "  Open:    ${URL}"
echo "  ${TAGLINE}"
echo
echo "OS pieces this package cannot ship (set up once):"
echo "  - USB-serial driver/modules so /dev/ttyUSB* or /dev/ttyACM* exists"
echo "  - dialout group (install.sh tried to add you — log out/in once)"
echo "  - Desktop session only if you need the Electron overlay"
echo "  Details: SPECTRE-Install-Guide.pdf / docs/INSTALL.md"
if [[ -n "${SUDO_USER:-}" ]]; then
  echo "  Next: log out/in as ${SUDO_USER}, plug the adapter, open ${URL}"
fi
