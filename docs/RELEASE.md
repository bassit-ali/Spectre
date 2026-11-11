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

- **Fully offline packages**: Node.js LTS, production npm deps (`fastify`, `serialport`, `ws`, `@fastify/static`), serialport native prebuilds, and Electron overlay are all inside the installer/archives
- Linux packages no longer run `npm install` at install time for Electron
- Pack-time `verify-payload.ps1` gate fails the build if any offline essential is missing
- Install scripts prefer / restore bundled runtime binaries (`runtime/`, executable bits on Linux)

## Still OS-provided (cannot ship in the archive)

- USB-serial kernel/driver (CH340 / FTDI / CP210x)
- Linux: `systemd`, `dialout` / udev (rules are written by `install.sh`)
- A logged-on desktop session if you want the Electron overlay (browser widget works headless)

## Build

```powershell
.\installers\windows\build.ps1 -Version 1.1.4
.\installers\linux\package.ps1 -Version 1.1.4
.\installers\common\build-install-guide.ps1
```
