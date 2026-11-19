# SPECTRE v1.1.8

## Artifacts

Download from **[GitHub Releases (latest)](https://github.com/bassit-ali/Spectre/releases/latest)** — do not commit binaries to git.

| File | Platform |
|------|----------|
| `SPECTRE-Setup.exe` | Windows x64 installer (recommended) |
| `SPECTRE-windows-x64-v1.1.8.zip` | Windows portable + `install.ps1` |
| `spectre-linux-x64.tar.gz` | Linux x86_64 |
| `spectre-linux-arm64.tar.gz` | Linux ARM64 / Pi |
| `SPECTRE-Install-Guide.pdf` | Install guide (same content as [INSTALL.md](INSTALL.md)) |

## Changes (v1.1.8)

- **Linux Open Widget** launches the real always-on-top Electron overlay (like Windows), by attaching to the logged-in desktop seat and running Electron as that user — not a browser tab
- Headless / no GUI session still falls back to `/widget.html` only as a last resort

## Inherited from v1.1.7

- Soft tilt defaults **−30° … +35°** (editable in Settings within ±60°)
- Bundled **Node.js 22.23.5**, HALT/sphere fix, degree nudges, Settings jump

## Shipped in the archive

Node under `runtime/` · fastify / @fastify/static / ws / serialport · Electron · web UI

## Windows trusted installer (optional)

Unsigned Setup triggers SmartScreen. Signing: [CODE-SIGNING.md](CODE-SIGNING.md).

## Cannot ship (OS / hardware)

| Item | Why | What you do |
|------|-----|-------------|
| USB-serial driver | Vendor/kernel driver | Install CH340 / FTDI / CP210x driver (Windows); Linux modules usually present |
| Windows Admin | Elevation for Program Files + autostart | Run Setup elevated; SmartScreen *Run anyway* if trusted |
| Linux systemd | OS init | Use a systemd distro |
| Linux dialout / udev | Device permissions | `install.sh` configures; **log out/in** once |
| Desktop session | Overlay UI | Stay logged into the local GUI so Open Widget can show the Electron overlay |
| Pelco-D head | Hardware | Power, address, cabling |

Step-by-step: [INSTALL.md — OS / hardware setup](INSTALL.md#os--hardware-setup-do-this-once).

## Build

```powershell
npm run pack:win
npm run pack:linux
# or:
.\installers\windows\build.ps1 -Version 1.1.8
.\installers\linux\package.ps1 -Version 1.1.8
.\installers\common\build-install-guide.ps1 -Version 1.1.8
```

Artifacts land in `release/` (gitignored). Attach them to the GitHub Release for this tag.
