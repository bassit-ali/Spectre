#!/usr/bin/env bash
set -euo pipefail

APP_NAME="pelco-pt"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${HOME}/.local/opt/${APP_NAME}"
BIN_DIR="${HOME}/.local/bin"
AUTOSTART_DIR="${HOME}/.config/autostart"
APP_DIR="${HOME}/.local/share/applications"

echo "==> Installing PelcoPT to ${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}" "${BIN_DIR}" "${AUTOSTART_DIR}" "${APP_DIR}"

# Prefer already-unpacked electron-builder output beside this script package
if [[ -d "${SRC_DIR}/pelco-pt-linux-unpacked" ]]; then
  rsync -a --delete "${SRC_DIR}/pelco-pt-linux-unpacked/" "${INSTALL_DIR}/"
elif [[ -x "${SRC_DIR}/PelcoPT" ]]; then
  rsync -a --delete "${SRC_DIR}/" "${INSTALL_DIR}/" --exclude install.sh --exclude uninstall.sh
elif [[ -x "${SRC_DIR}/${APP_NAME}" ]]; then
  rsync -a --delete "${SRC_DIR}/" "${INSTALL_DIR}/" --exclude install.sh --exclude uninstall.sh
else
  echo "Could not find unpacked Linux app next to install.sh" >&2
  echo "Expected PelcoPT binary or pelco-pt-linux-unpacked/" >&2
  exit 1
fi

BIN_TARGET="${INSTALL_DIR}/PelcoPT"
if [[ ! -x "${BIN_TARGET}" ]]; then
  BIN_TARGET="$(find "${INSTALL_DIR}" -maxdepth 2 -type f -name 'PelcoPT' | head -n1 || true)"
fi
if [[ -z "${BIN_TARGET}" || ! -x "${BIN_TARGET}" ]]; then
  echo "PelcoPT executable not found after copy" >&2
  exit 1
fi

ln -sfn "${BIN_TARGET}" "${BIN_DIR}/pelco-pt"

# Serial access: add dialout if possible
if ! id -nG "${USER}" | tr ' ' '\n' | grep -qx dialout; then
  if command -v sudo >/dev/null 2>&1; then
    echo "==> Adding ${USER} to dialout (sudo)"
    sudo usermod -aG dialout "${USER}" || true
    echo "    Log out/in (or reboot) for dialout group to apply."
  else
    echo "WARN: not in dialout and sudo unavailable — serial may fail."
  fi
fi

# Optional udev rule for CH340 / ttyUSB
if command -v sudo >/dev/null 2>&1; then
  RULE='/etc/udev/rules.d/99-pelco-pt-usbserial.rules'
  echo "==> Writing udev rule ${RULE}"
  sudo tee "${RULE}" >/dev/null <<'EOF'
# CH340 / common USB-serial adapters for PelcoPT
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", MODE="0660", GROUP="dialout"
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", MODE="0660", GROUP="dialout"
SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", MODE="0660", GROUP="dialout"
EOF
  sudo udevadm control --reload-rules || true
  sudo udevadm trigger || true
fi

DESKTOP_FILE="${APP_DIR}/pelco-pt.desktop"
cat > "${DESKTOP_FILE}" <<EOF
[Desktop Entry]
Type=Application
Name=PelcoPT
Comment=Pelco-D pan/tilt controller
Exec=${BIN_TARGET}
Icon=${INSTALL_DIR}/resources/icon.png
Terminal=false
Categories=Utility;
StartupNotify=true
X-GNOME-Autostart-enabled=true
EOF

AUTOSTART_FILE="${AUTOSTART_DIR}/pelco-pt.desktop"
cp "${DESKTOP_FILE}" "${AUTOSTART_FILE}"

# Optional user systemd unit
SYSTEMD_DIR="${HOME}/.config/systemd/user"
mkdir -p "${SYSTEMD_DIR}"
cat > "${SYSTEMD_DIR}/pelco-pt.service" <<EOF
[Unit]
Description=PelcoPT pan/tilt controller
After=default.target

[Service]
Type=simple
ExecStart=${BIN_TARGET}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload || true
  systemctl --user enable pelco-pt.service || true
fi

# Copy browser extension for optional load
if [[ -d "${SRC_DIR}/extension" ]]; then
  mkdir -p "${INSTALL_DIR}/extension"
  rsync -a "${SRC_DIR}/extension/" "${INSTALL_DIR}/extension/"
  echo "==> Browser extension copied to ${INSTALL_DIR}/extension"
  echo "    Chrome/Edge: chrome://extensions → Load unpacked → that folder"
fi

echo
echo "Installed. Autostart registered."
echo "Run now:  pelco-pt"
echo "Or:       ${BIN_TARGET}"
echo "Uninstall: ${SRC_DIR}/uninstall.sh  (or ${INSTALL_DIR}/../uninstall if packaged)"
