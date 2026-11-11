# SPECTRE v1.1.3

## Artifacts

| File | Platform |
|------|----------|
| `release/SPECTRE-Setup.exe` | Windows x64 installer |
| `release/SPECTRE-windows-x64-v1.1.3.zip` | Windows portable + `install.ps1` |
| `release/spectre-linux-x64.tar.gz` | Linux x86_64 |
| `release/spectre-linux-arm64.tar.gz` | Linux ARM64 / Pi |
| `release/SPECTRE-Install-Guide.pdf` | Install guide |

## Changes

- **Bundled Node.js LTS** in Windows and Linux packages (`runtime/`) — no separate Node install for end users
- Offline-capable Setup.exe / Linux tarballs (service starts with packaged `node`)
- Docs/README updated for installer-first offline install

## Build

```powershell
.\installers\windows\build.ps1 -Version 1.1.3
.\installers\linux\package.ps1 -Version 1.1.3
.\installers\common\build-install-guide.ps1
```
