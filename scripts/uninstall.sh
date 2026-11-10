#!/usr/bin/env bash
set -euo pipefail

APP_NAME="pelco-pt"
INSTALL_DIR="${HOME}/.local/opt/${APP_NAME}"
BIN_LINK="${HOME}/.local/bin/pelco-pt"
AUTOSTART_FILE="${HOME}/.config/autostart/pelco-pt.desktop"
DESKTOP_FILE="${HOME}/.local/share/applications/pelco-pt.desktop"
SERVICE_FILE="${HOME}/.config/systemd/user/pelco-pt.service"

echo "==> Stopping PelcoPT if running"
pkill -f '/.local/opt/pelco-pt/.*PelcoPT' 2>/dev/null || true

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now pelco-pt.service 2>/dev/null || true
fi

rm -f "${BIN_LINK}" "${AUTOSTART_FILE}" "${DESKTOP_FILE}" "${SERVICE_FILE}"
rm -rf "${INSTALL_DIR}"

echo "PelcoPT removed."
