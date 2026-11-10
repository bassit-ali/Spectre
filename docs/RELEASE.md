# SPECTRE release notes — v1.1.0

**Developed by 26 Sig Bn R&D Wing**

## Ship artifacts (build locally — not committed to git)

| File | Platform | Notes |
|------|----------|--------|
| `release/SPECTRE-Setup.exe` | Windows x64 | Recommended NSIS installer (Admin) |
| `release/SPECTRE-windows-x64-portable.zip` | Windows x64 | Portable payload + `install.ps1` |
| `release/SPECTRE-windows-x64-v1.1.0.zip` | Windows x64 | Versioned copy of portable ZIP |
| `release/spectre-linux-x64.tar.gz` | Linux x86_64 | Extract + `sudo ./install.sh` |
| `release/spectre-linux-arm64.tar.gz` | Linux ARM64 / Pi | Same |
| `release/SPECTRE-Linux-Install-Guide.pdf` | Docs | Also `.md` / `.html` beside it |

Large binaries stay under `release/` (gitignored). Attach them to a **GitHub Release** tagged `v1.1.0`.

## Highlights

- 2D pan pad + vertical tilt rail (console + widget); fine pan slider removed
- Soft tilt limits hardcoded **±50°**
- Home / storage settle band **±1.5°**; landing resolution 0.5° / 1° / 2°
- Sector presets A@0° / B@120° / C@240° × Low (−20°) / Level (0°) / High (+25°)
- Widget opens with RS-485 offline (**No device connected** banner); pin in header; click **SPECTRE** opens console
- Windows installer stages **Electron pip-shell** and uses **HKLM Run** autostart (user session) so the overlay can appear
- UX regression: **130/130** green

## Build commands

```powershell
.\installers\windows\build.ps1 -Version 1.1.0
.\installers\linux\package.ps1 -Version 1.1.0
.\installers\linux\build-guide.ps1
```

## Verification checklist

- [ ] `SPECTRE-Setup.exe` contains `pip-shell\node_modules\electron\dist\electron.exe`
- [ ] Payload `controller.js` has `HOME_BAND_DEG = 1.5` and `tiltMin: -50`
- [ ] Widget HTML contains `widget-offline-banner` and no opacity slider
- [ ] `npm run test:ux` → 130/130
- [ ] Fresh install: service on `:9000`, widget overlay, Start Menu shortcuts, logon autostart
