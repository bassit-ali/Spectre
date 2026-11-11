# SPECTRE v1.1.4

## Artifacts

| File | Platform |
|------|----------|
| `release/SPECTRE-Setup.exe` | Windows x64 installer |
| `release/SPECTRE-windows-x64-v1.1.4.zip` | Windows portable + `install.ps1` |
| `release/spectre-linux-x64.tar.gz` | Linux x86_64 |
| `release/spectre-linux-arm64.tar.gz` | Linux ARM64 / Pi |
| `release/SPECTRE-Install-Guide.pdf` | Install guide |

## Changes

- Fully offline packages: Node.js LTS, production npm deps, serialport natives, Electron
- Pack-time payload verification
- Install docs spell out **what cannot ship** (USB-serial driver, Admin/systemd/dialout, desktop session) with how-to steps

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
.\installers\windows\build.ps1 -Version 1.1.4
.\installers\linux\package.ps1 -Version 1.1.4
.\installers\common\build-install-guide.ps1
```
