# SPECTRE v1.1.2

## Artifacts

| File | Platform |
|------|----------|
| `release/SPECTRE-Setup.exe` | Windows x64 installer |
| `release/SPECTRE-windows-x64-v1.1.2.zip` | Windows portable + `install.ps1` |
| `release/spectre-linux-x64.tar.gz` | Linux x86_64 |
| `release/spectre-linux-arm64.tar.gz` | Linux ARM64 / Pi |
| `release/SPECTRE-Install-Guide.pdf` | Install guide |

Attach these to the GitHub Release tagged **v1.1.2**. Steps: [INSTALL.md](INSTALL.md).

## Changes

- Product tree trimmed to `server/`, `web/`, `pip-shell/`, `installers/`, `docs/`, `scripts/`
- Installer-first docs and regenerated Install Guide PDF
- Console / widget screenshots in `docs/screenshots/`
- Console type scale and control hit targets; widget density restored
- Widget opacity control, minimize motion, Enable/Disable for overlay options
- Transparent favicon; connection wording (Serial / LAN / No Device Connected)

## Build

```powershell
.\installers\windows\build.ps1 -Version 1.1.2
.\installers\linux\package.ps1 -Version 1.1.2
.\installers\common\build-install-guide.ps1
```

Or: `npm run pack:win`, `npm run pack:linux`, `npm run pack:docs`.

## Checklist

- [x] `npm run test:ux`
- [x] `npm run test:transport`
- [x] Setup.exe includes pip-shell Electron
- [ ] Fresh install smoke: `:9000`, widget, shortcuts / autostart
