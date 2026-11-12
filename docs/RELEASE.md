# SPECTRE v1.1.5

## Artifacts

| File | Platform |
|------|----------|
| `release/SPECTRE-Setup.exe` | Windows x64 installer |
| `release/SPECTRE-windows-x64-v1.1.5.zip` | Windows portable + `install.ps1` |
| `release/spectre-linux-x64.tar.gz` | Linux x86_64 |
| `release/spectre-linux-arm64.tar.gz` | Linux ARM64 / Pi |
| `release/SPECTRE-Install-Guide.pdf` | Install guide |

## Changes

- Bundled **Node.js 22.23.5** (fixes `ERR_REQUIRE_ESM` crash with `@fastify/static` / `content-disposition@3` on Node 20.18)
- Pack-time `runtime/NODE_VERSION.txt` + static smoke (native hosts) / version assert (cross-pack)
- Installer waits for `/health` before opening the browser; `spectre.cmd` pauses on crash
- **HALT** cancels in-flight sphere `goto` so the pan pad works again after emergency stop
- **1° / 5° / 10°** buttons are closed-loop degree nudges (click = that many degrees; hold repeats)
- Sphere aim spot shows a live **pan degree tag**
- Header **Settings** jumps to Link · Drive · Widget (Hardware Link / Ethernet)

## Shipped in the archive

Node under `runtime/` · fastify / @fastify/static / ws / serialport · Electron · web UI

## Windows trusted installer (optional next step)

Unsigned Setup triggers SmartScreen. To ship a signed `SPECTRE-Setup.exe`, use Azure Artifact Signing or an OV code-signing cert and the repo hook in `installers/windows/sign-setup.ps1`. Details: [CODE-SIGNING.md](CODE-SIGNING.md).

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
.\installers\windows\build.ps1 -Version 1.1.5
.\installers\linux\package.ps1 -Version 1.1.5
.\installers\common\build-install-guide.ps1
```
