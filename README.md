# SPECTRE

Local Pelco-D pan/tilt controller — web console on `127.0.0.1:9000`, optional always-on-top desktop widget, closed-loop landing, sector presets, and halt.

[![Release](https://img.shields.io/github/v/release/bassit-ali/Spectre?style=flat-square)](https://github.com/bassit-ali/Spectre/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**v1.1.4** · [Downloads](https://github.com/bassit-ali/Spectre/releases/tag/v1.1.4) · Console: http://127.0.0.1:9000/ · Widget: http://127.0.0.1:9000/widget.html

![SPECTRE console](docs/screenshots/console.png)

![SPECTRE widget](docs/screenshots/widget.png)

Full-page console shot: [docs/screenshots/console-full.png](docs/screenshots/console-full.png)

---

## Install

Release packages are **fully offline**. They already include Node.js, production npm modules, serialport natives, and the Electron overlay. You do **not** install Node.js or run `npm install` on the target machine.

| File | Platform |
|------|----------|
| **SPECTRE-Setup.exe** | Windows x64 (recommended) |
| `SPECTRE-windows-x64-v1.1.4.zip` | Windows portable + `install.ps1` |
| `spectre-linux-x64.tar.gz` | Linux x86_64 |
| `spectre-linux-arm64.tar.gz` | Linux ARM64 / Pi |
| `SPECTRE-Install-Guide.pdf` | Printable guide |

Field steps: [docs/INSTALL.md](docs/INSTALL.md). Release notes: [docs/RELEASE.md](docs/RELEASE.md).

### What’s inside every package

- Bundled **Node.js LTS** under `runtime/`
- Server deps: **fastify**, **@fastify/static**, **ws**, **serialport** (+ arch prebuilds)
- **Electron** desktop overlay under `pip-shell/`
- Web console + widget (`web/dist`)

Still OS-side (not in the archive): USB-serial driver, and on Linux `systemd` + `dialout` (udev rules are written by the installer).

### Windows

1. Run **SPECTRE-Setup.exe** as Administrator.
2. Open http://127.0.0.1:9000/ after install (or after logon — the service starts with your user session).

The Setup binary is unsigned; on SmartScreen use *More info → Run anyway* for builds you trust.

Portable path:

```powershell
Expand-Archive SPECTRE-windows-x64-v1.1.4.zip -DestinationPath C:\Temp\spectre
cd C:\Temp\spectre
.\install.ps1   # elevated
```

Uninstall: Apps → SPECTRE, or `.\installers\windows\uninstall-system.ps1` (elevated).

### Linux / Pi

```bash
tar -xzf spectre-linux-x64.tar.gz   # or spectre-linux-arm64.tar.gz
cd spectre
sudo ./install.sh
```

Installs under `/opt/spectre`, enables `spectre.service`, restores execute bits on the bundled runtime, and sets USB-serial udev / `dialout` when it can. No system Node/npm required.

---

## First run

1. Confirm the header shows the server connected.
2. Plug the USB-serial adapter → **Ports** → pick COM / `/dev/ttyUSB*`, **9600**, address **1** → **Connect**.
3. Hit **HALT** once before you jog.
4. Optional: **RUN SELF-TEST**.

RS-485 is the default link. Ethernet UDP is optional in **Hardware Link** (same Pelco-D commands; different wire). Leave “prefer UDP” off unless you want boot auto-connect to try LAN first.

---

## What you get

- **2D pan pad** and **vertical tilt rail** (−50°…+50°)
- Absolute **GO TO** with encoder landing (0.5° / 1° / 2° band)
- **Home** settle ±1.5°
- **3×3 sector presets** (A/B/C × Low / Level / High)
- Console + widget **HALT**
- Widget still opens when the bus is down (offline banner)
- Windows logon autostart; Linux **systemd**

Config lives under `C:\ProgramData\SpectrePT\config.json` on Windows (Linux path is logged at boot).

---

## Develop from source

Only needed when changing the code. If a system install already owns port 9000, uninstall it first.

```bash
npm install
npm --prefix web install
npm --prefix pip-shell install
npm run build
npm run server:start
# optional overlay:
npm run pip:start
```

UI watch: `npm run web:dev` · server watch: `npm run dev:server`

### Tests

```bash
npm run test:ux          # no hardware
npm run test:transport   # RS-485 vs UDP command parity
npm run test:regression  # needs live serial + encoders
```

### Rebuild packages

```powershell
npm run pack:win
npm run pack:linux
npm run pack:docs
```

Artifacts land in `release/` (gitignored). Attach them to a GitHub Release; do not commit the binaries.

---

## Layout

```
server/      Fastify + serial + motion
web/         console + widget (Vite)
pip-shell/   Electron always-on-top shell
installers/  Windows NSIS, Linux tar + install.sh, guide PDF
scripts/     ship gates; scripts/lab/ for hardware probes
docs/        INSTALL.md, RELEASE.md, screenshots/
```

---

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| Port 9000 busy | Uninstall system SPECTRE or stop the other Node process |
| No link | Wrong COM, missing USB-serial driver, address ≠ 1, head powered off |
| Widget missing | Confirm Electron is in the package; Windows needs a logged-on session |
| Linux serial denied | User in `dialout`, replug, `systemctl restart spectre` |
| Native module mismatch | `PATH="$PWD/runtime/bin:$PATH" npm rebuild serialport` then restart |

```bash
curl http://127.0.0.1:9000/health
```

---

MIT — see [LICENSE](LICENSE).
