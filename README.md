# SPECTRE

**Pan-tilt pedestal controller** for Pelco-D heads over RS-485.

Local web console + always-on-top desktop widget, closed-loop encoder landing, sector presets, and emergency halt — built for field use on Windows and Linux (including Raspberry Pi).

[![Release](https://img.shields.io/github/v/release/bassit-ali/Spectre?style=flat-square&label=release)](https://github.com/bassit-ali/Spectre/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20Pi-111111?style=flat-square)](https://github.com/bassit-ali/Spectre/releases)
[![Protocol](https://img.shields.io/badge/bus-RS--485%20Pelco--D-0ea5e9?style=flat-square)](#what-spectre-does)

| | |
|---|---|
| **Version** | **1.1.0** |
| **Repository** | [github.com/bassit-ali/Spectre](https://github.com/bassit-ali/Spectre) |
| **Downloads** | [Releases · v1.1.0](https://github.com/bassit-ali/Spectre/releases/tag/v1.1.0) |
| **Console** | http://127.0.0.1:9000/ |
| **Widget** | http://127.0.0.1:9000/widget.html |
| **WebSocket** | `ws://127.0.0.1:9000/ws` |
| **License** | MIT |

---

## Table of contents

1. [What SPECTRE does](#what-spectre-does)
2. [Features (v1.1.0)](#features-v110)
3. [Architecture](#architecture)
4. [Requirements](#requirements)
5. [Download / install — Windows](#download--install--windows)
6. [Download / install — Linux / Raspberry Pi](#download--install--linux--raspberry-pi)
7. [First run — connect the head](#first-run--connect-the-head)
8. [Web console guide](#web-console-guide)
9. [Floating widget guide](#floating-widget-guide)
10. [Sector presets](#sector-presets)
11. [Motion, home & soft limits](#motion-home--soft-limits)
12. [Configuration](#configuration)
13. [Safety](#safety)
14. [Develop from source](#develop-from-source)
15. [Tests & quality gates](#tests--quality-gates)
16. [Rebuild release artifacts](#rebuild-release-artifacts)
17. [Publishing to GitHub](#publishing-to-github)
18. [Troubleshooting](#troubleshooting)
19. [Repository layout](#repository-layout)

---

## What SPECTRE does

SPECTRE is a **local-only** control stack for a Pelco-D pan/tilt pedestal:

1. A **Node.js Fastify service** binds to `127.0.0.1:9000`, talks USB-serial RS-485, and closes the loop on pan/tilt angle queries.
2. A **static web console** (Vite-built) provides the full operator UI.
3. An optional **Electron pip-shell** loads the widget page as a frameless, always-on-top overlay after logon.

It does **not** require cloud services. By default nothing listens outside localhost.

Typical field link (configurable):

- USB-serial adapter (often CH340) e.g. **COM13**
- **9600 8N1**
- Pelco-D camera **address 1**

---

## Features (v1.1.0)

| Area | Detail |
|------|--------|
| **Pan control** | Click/drag 2D pad (0–360°). No separate fine-pan slider — the pad is the pan surface. |
| **Tilt control** | Vertical slider, soft limits **−50° … +50°** (hardcoded, not field-editable). |
| **Goto** | Absolute pan/tilt with encoder closed-loop landing. |
| **Landing band** | Selectable **0.5° / 1° / 2°** settle window for goto. |
| **Home / storage** | Settle within **±1.5°** of home (circular pan distance). |
| **Presets** | 3×3 matrix: A0 / B120 / C240 × Low (−20°) / Level (0°) / High (+25°). |
| **Halt** | Immediate stop on console, widget, and header. |
| **Offline widget** | Overlay still opens with serial down; clear offline banner. |
| **Autostart (Windows)** | HKLM `Run` at user logon so Electron can show a desktop UI. |
| **Linux service** | `systemd` unit under `/opt/spectre`. |
| **Self-test** | Boot BIT + console **RUN SELF-TEST**. |

---

## Architecture

```
┌─────────────────────┐     HTTP / WS      ┌──────────────────────────┐
│  Web console        │◄──────────────────►│  Fastify server :9000    │
│  (web/dist)         │                    │  server/dist/src/index   │
└─────────────────────┘                    │                          │
┌─────────────────────┐     same URLs      │  • serialport (Pelco-D)  │
│  Electron pip-shell │◄──────────────────►│  • motion controller     │
│  → widget.html      │                    │  • presets / settings    │
└─────────────────────┘                    └────────────┬─────────────┘
                                                        │ RS-485
                                                        ▼
                                               Pelco-D pan/tilt head
```

| Piece | Path | Role |
|-------|------|------|
| Server | `server/` | Fastify + WS + serial + motion |
| Shared motion | `server/shared/` | Controller math (home band, limits) |
| Web UI | `web/` | Console + widget source (Vite) |
| Overlay | `pip-shell/` | Electron shell for always-on-top widget |
| Installers | `installers/windows`, `installers/linux` | NSIS / tar + install scripts |

---

## Requirements

### All platforms

- **Node.js LTS** (18+ recommended; 20 LTS preferred) on `PATH`
- USB-serial driver for your adapter (CH340 / FTDI / etc.)
- Pelco-D capable pan/tilt with angle query support for closed-loop landing

### Windows

- x64 Windows 10/11
- Administrator rights for the NSIS installer / `install.ps1`
- Optional: NSIS only needed when **rebuilding** `SPECTRE-Setup.exe`

### Linux

- x86_64 or aarch64 (Raspberry Pi 4/5 ARM64 builds provided)
- `systemd` for service install
- User in `dialout` (or equivalent) for serial
- Desktop `DISPLAY` for Electron overlay; otherwise use the browser widget

---

## Download / install — Windows

**Preferred:** grab signed-ready binaries from the GitHub Release  
→ [**v1.1.0 assets**](https://github.com/bassit-ali/Spectre/releases/tag/v1.1.0)

Local rebuilds land under `release/` (gitignored — too large for the repo).

| Artifact | Use |
|----------|-----|
| **`SPECTRE-Setup.exe`** | Recommended all-users installer (~84 MB, includes Electron overlay) |
| `SPECTRE-windows-x64-portable.zip` | Portable tree + `install.ps1` |
| `SPECTRE-windows-x64-v1.1.0.zip` | Same ZIP, versioned filename |

### Recommended: Setup.exe

1. Install **Node.js LTS** if it is not already on `PATH`.
2. Run **`SPECTRE-Setup.exe` as Administrator**.
3. After install / logon, open **http://127.0.0.1:9000/**.
4. The desktop widget starts with the service when a user session is active.

What the installer does:

- Copies the app to `C:\Program Files\SPECTRE\`
- Installs production `node_modules` (including `serialport`)
- Stages **pip-shell** with Electron for the overlay
- Creates Start Menu shortcuts
- Registers **HKLM** `Software\Microsoft\Windows\CurrentVersion\Run` → SPECTRE  
  (user logon — required so Electron can draw on the desktop; a SYSTEM scheduled task cannot)
- Writes uninstall metadata under Programs and Features

> **SmartScreen:** the Setup binary is **unsigned**. On trusted builds choose *More info → Run anyway*.

### Portable / script install

```powershell
# Elevated PowerShell
Expand-Archive SPECTRE-windows-x64-portable.zip -DestinationPath C:\Temp\spectre-payload
cd C:\Temp\spectre-payload
.\install.ps1
```

### Uninstall

```powershell
# Elevated
.\installers\windows\uninstall-system.ps1
```

Or use **Apps → SPECTRE → Uninstall**.

---

## Download / install — Linux / Raspberry Pi

| Artifact | Arch |
|----------|------|
| `spectre-linux-x64.tar.gz` | x86_64 |
| `spectre-linux-arm64.tar.gz` | ARM64 / Pi |
| `SPECTRE-Linux-Install-Guide.pdf` | Full printable guide |

```bash
tar -xzf spectre-linux-x64.tar.gz   # or spectre-linux-arm64.tar.gz
cd spectre
sudo ./install.sh
```

The installer:

- Installs to `/opt/spectre`
- Enables `spectre.service` (systemd)
- Opens / documents **http://127.0.0.1:9000/**
- Configures USB-serial udev rules and `dialout` when possible
- Runs `npm install` for Electron in `pip-shell/` when npm is available

**Cross-built archives:** rebuild native bindings on the target machine:

```bash
cd /opt/spectre
npm rebuild serialport
cd pip-shell && npm install --omit=dev   # optional overlay
sudo systemctl restart spectre.service
```

Service helpers:

```bash
sudo systemctl status spectre
sudo journalctl -u spectre -f
sudo systemctl restart spectre
```

---

## First run — connect the head

1. Open **http://127.0.0.1:9000/** — header should show **SERVER: WS ONLINE**.
2. Plug the USB-serial adapter; click **Ports** refresh in **Serial**.
3. Select the port (e.g. COM13 / `/dev/ttyUSB0`), baud **9600**, address **1**.
4. Click **Connect**. Ribbon should show **COM LINK: … ONLINE**.
5. Optional: **RUN SELF-TEST** to verify serial + encoder replies.
6. Use **HALT** once to confirm stop works before jogging.

If serial is disconnected, the **widget still opens** and shows the offline banner — useful for UI/demo without a head attached.

---

## Web console guide

| Control | Behavior |
|---------|----------|
| **Pan pad** | Click or drag to command pan angle. Badges mark sectors A/B/C. |
| **Tilt rail** | Drag vertical slider (−50° … +50°). Caps are labeled on the rail. |
| **Home** | Drive to storage/home pose; settle band ±1.5°. |
| **Tap step** | 1° / 5° / 10° jog increments for pad nudges. |
| **Jog buttons** | ◀ PAN − / PAN + ▶ / ▲ UP + / DOWN − ▼ |
| **GO TO** | Absolute target pan + tilt; closed-loop until inside land band. |
| **READ LIVE** | Refresh encoder pose into the goto fields. |
| **HALT** | Emergency stop (header + panel). |
| **Widget** | Requests `/api/widget/open` → launches pip-shell. |
| **Presets** | CALL / SET / CLR on each of 9 slots. |
| **Land band** | 0.5° / 1° / 2° chips in settings ribbon. |
| **Soft limits** | Tilt min/max shown read-only at ±50°. |

Version badge in the UI reads **v1.1.0** (from `web/package.json` at build time).

---

## Floating widget guide

| Control | Behavior |
|---------|----------|
| **SPECTRE** title | Opens the full console in the default browser. |
| **Pin** | Always-on-top toggle (header). |
| **Minimize** | Collapses the chrome toward the bottom edge (no page scroll). |
| **Pad + tilt** | Same geometry as console. |
| **CREEP / MAX** | Speed presets for jog. |
| **Land band** | 0.5° / 1° / 2°; home note ±1.5°. |
| **GO TO** | Compact pan/tilt + execute. |
| **HALT** | Full-width emergency stop. |
| **Quick-call** | One tap per sector preset (same slots as console). |
| **Offline banner** | Shown when RS-485 is not connected. |

Opacity chrome was removed; credit stays in the footer.

---

## Sector presets

Factory-oriented layout (programmable via UI or script):

| Slot | Name | Pan | Tilt |
|------|------|-----|------|
| 1 | Sector A Low | 0° | −20° |
| 2 | Sector A Level | 0° | 0° |
| 3 | Sector A High | 0° | +25° |
| 4 | Sector B Low | 120° | −20° |
| 5 | Sector B Level | 120° | 0° |
| 6 | Sector B High | 120° | +25° |
| 7 | Sector C Low | 240° | −20° |
| 8 | Sector C Level | 240° | 0° |
| 9 | Sector C High | 240° | +25° |

From a running service:

```bash
npm run presets:sectors
```

**SET** stores the live pose into that slot; **CLR** clears it; the sector script restores the matrix after a full clear if needed.

---

## Motion, home & soft limits

| Constant | Value | Notes |
|----------|-------|--------|
| `HOME_BAND_DEG` | **1.5°** | Home / storage done when within band (circular pan). |
| Landing resolution | 0.5 / 1 / 2 ° | Operator selectable. |
| `tiltMin` / `tiltMax` | **−50 / +50** | Hardcoded soft limits. |
| Pan range | typically −180…+180 or 0…360 | Per settings / head. |

Always prefer **HALT** before unplugging serial or powering the head down mid-move.

---

## Configuration

Default Windows config path:

`C:\ProgramData\SpectrePT\config.json`

(Linux: under `/opt/spectre` / XDG-style data dir as installed.)

Persists serial port selection, speeds, land band, widget visibility/pin, and presets. The service logs the active config path at boot (`[spectre] INFO config: …`).

---

## Safety

- Use **HALT** before reconnecting or power-cycling the pedestal.
- Soft tilt limits (±50°) stay enforced in software — they are not a substitute for mechanical stops.
- Service binds to **localhost** by default; do not expose `:9000` to untrusted networks without an explicit reverse-proxy / auth design.
- Installers are **unsigned**; only install builds you trust.
- Moving heads can injure people and equipment — keep the sweep clear during goto and preset CALL.

---

## Develop from source

If a system install already owns port 9000, uninstall it first:

```powershell
.\installers\windows\uninstall-system.ps1   # elevated
```

```bash
# Install
npm install
npm --prefix web install
npm --prefix pip-shell install

# Build
npm --prefix web run build
npm run server:build

# Run service
npm run server:start

# Optional overlay
npm run pip:start
```

Dev watch (TypeScript server):

```bash
npm run dev:server
```

Web UI during UI work (Vite):

```bash
cd web && npm run dev
```

(Point the running server’s static root at `web/dist` after `npm run build`, or use Vite proxy as configured in your workflow.)

---

## Tests & quality gates

```bash
# UI / copy / pad math / parity — no hardware required
npm run test:ux

# Full motion regression — needs live COM + encoders
npm run test:regression
```

Ship gate for UI: **`npm run test:ux` → 130/130 passed**.

---

## Rebuild release artifacts

From a clean tree on Windows (PowerShell):

```powershell
.\installers\windows\build.ps1 -Version 1.1.0
.\installers\linux\package.ps1 -Version 1.1.0
.\installers\linux\build-guide.ps1
```

On a Linux builder:

```bash
VERSION=1.1.0 ./installers/linux/package.sh
```

Windows build stages:

1. Build `web` + `server`
2. Stage `release/windows/payload` (server, web, pip-shell + Electron, `node_modules`)
3. Zip portable payload
4. Run **makensis** → `release/SPECTRE-Setup.exe`

Linux build stages payload tarballs for x64 and arm64; `install.sh` completes Electron on-device when possible.

Release checklist: see [`docs/RELEASE.md`](docs/RELEASE.md).

---

## Publishing to GitHub

Remote: **[bassit-ali/Spectre](https://github.com/bassit-ali/Spectre)**

What lives in git vs Releases:

| In the repo | On the Release page |
|-------------|---------------------|
| Source, README, installer scripts | `SPECTRE-Setup.exe` |
| `docs/`, `LICENSE`, UX tests | Windows portable ZIPs |
| | Linux `.tar.gz` + install guide PDF |

`release/` binaries, `node_modules/`, and built `*/dist` trees are **gitignored**.

```bash
git add .
git status   # confirm no node_modules / *.exe
git commit -m "Release SPECTRE v1.1.0 — pan-tilt controller"
git branch -M main
git remote add origin https://github.com/bassit-ali/Spectre.git   # once
git push -u origin main
gh release create v1.1.0 release/SPECTRE-Setup.exe \
  release/SPECTRE-windows-x64-portable.zip \
  release/spectre-linux-x64.tar.gz \
  release/spectre-linux-arm64.tar.gz \
  release/SPECTRE-Linux-Install-Guide.pdf \
  --title "SPECTRE v1.1.0" --notes-file docs/RELEASE.md
```

---

## Troubleshooting

| Symptom | Likely fix |
|---------|------------|
| Port 9000 in use | Uninstall system SPECTRE or stop the other Node process. |
| **NO LINK** / BIT serial fail | Wrong COM, driver missing, address ≠ 1, or head powered off. |
| Widget never appears | Confirm pip-shell/Electron staged; on Windows use logon Run (not SYSTEM task). On Linux need `DISPLAY`. |
| SmartScreen blocks Setup | Unsigned build — *More info → Run anyway* on trusted media. |
| Linux serial permission | Add user to `dialout`, replug adapter, `sudo systemctl restart spectre`. |
| Native module errors after copy | `npm rebuild serialport` on the target OS/arch. |
| Preset **Sector C High** missing | Re-run `npm run presets:sectors` or SET slot 9 from console. |
| Overlay opens then exits | Check server logs for pip-shell; open `/widget.html` in a browser as fallback. |

Health probe:

```bash
curl http://127.0.0.1:9000/health
```

---

## Repository layout

```
├── README.md                 ← this file
├── LICENSE
├── package.json              ← root scripts + server deps (v1.1.0)
├── server/                   ← Fastify service + shared controller
├── web/                      ← console + widget (Vite)
├── pip-shell/                ← Electron always-on-top shell
├── installers/
│   ├── windows/              ← build.ps1, Spectre.nsi, install.ps1
│   ├── linux/                ← package + install.sh + guide
│   └── common/               ← stage-pip-shell.ps1
├── scripts/                  ← regression-ux, regression-full, presets
├── docs/
│   └── RELEASE.md
└── release/                  ← build output (gitignored)
```

---

MIT License — see [`LICENSE`](LICENSE).
