# SPECTRE v1.1.6

## Artifacts

Download from **[GitHub Releases (latest)](https://github.com/bassit-ali/Spectre/releases/latest)** — do not commit binaries to git.

| File | Platform |
|------|----------|
| `SPECTRE-Setup.exe` | Windows x64 installer (recommended) |
| `SPECTRE-windows-x64-v1.1.6.zip` | Windows portable + `install.ps1` |
| `spectre-linux-x64.tar.gz` | Linux x86_64 |
| `spectre-linux-arm64.tar.gz` | Linux ARM64 / Pi |
| `SPECTRE-Install-Guide.pdf` | Install guide (same content as [INSTALL.md](INSTALL.md)) |

## Changes (v1.1.6)

- Refreshed **install guide** (PDF/HTML/MD) and README install steps for the current build
- Repo hygiene: local pack staging / release binaries stay gitignored — **git + GitHub Releases** only
- Same runtime as 1.1.5: bundled **Node.js 22.23.5**, HALT/sphere fix, degree nudges, Settings jump

## Inherited from v1.1.5

- Bundled **Node.js 22.23.5** (fixes `ERR_REQUIRE_ESM` on Node 20.18)
- Pack-time `runtime/NODE_VERSION.txt` + payload smoke checks
- Installer waits for `/health` before opening the browser; `spectre.cmd` pauses on crash
- **HALT** cancels in-flight sphere `goto` and resolves hung approach loops
- **1° / 5° / 10°** closed-loop degree nudges; sphere aim spot shows a live pan degree tag
- Header **Settings** jumps to Link · Drive · Widget

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
| Desktop session | Overlay UI | Optional — browser widget works headless |
| Pelco-D head | Hardware | Power, address, cabling |

Step-by-step: [INSTALL.md — OS / hardware setup](INSTALL.md#os--hardware-setup-do-this-once).

## Build

```powershell
npm run pack:win
npm run pack:linux
# or:
.\installers\windows\build.ps1 -Version 1.1.6
.\installers\linux\package.ps1 -Version 1.1.6
.\installers\common\build-install-guide.ps1 -Version 1.1.6
```

Artifacts land in `release/` (gitignored). Attach them to the GitHub Release for this tag.
