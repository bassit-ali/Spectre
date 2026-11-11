# SPECTRE release notes — v1.1.1

## Ship artifacts (build locally — not committed to git)

| File | Platform | Notes |
|------|----------|--------|
| `release/SPECTRE-Setup.exe` | Windows x64 | Recommended NSIS installer (Admin) |
| `release/SPECTRE-windows-x64-portable.zip` | Windows x64 | Portable payload + `install.ps1` |
| `release/SPECTRE-windows-x64-v1.1.1.zip` | Windows x64 | Versioned copy of portable ZIP |
| `release/spectre-linux-x64.tar.gz` | Linux x86_64 | Extract + `sudo ./install.sh` |
| `release/spectre-linux-arm64.tar.gz` | Linux ARM64 / Pi | Same |
| `release/SPECTRE-Linux-Install-Guide.pdf` | Docs | Also `.md` / `.html` beside it |

Large binaries stay under `release/` (gitignored). Attach them to a **GitHub Release** tagged `v1.1.1`.

## Why this release

Production hang: the web console spun forever, buttons did nothing, and the desktop widget would not open. Root cause was event-loop starvation — unbounded `serial.tx` / `serial.rx` WebSocket broadcasts filled memory (~1 GB) when a client stopped draining, GC thrashed, and static HTTP / widget APIs timed out. `/health` could still answer intermittently while `GET /` failed.

Self-test (BIT) previously only checked config/serial/encoders, so it never detected or remediated this failure mode.

## Highlights (v1.1.1)

- **Stop bus flood:** raw `serial.tx` / `serial.rx` are debug-only (`SPECTRE_DEBUG_BUS=1`)
- **WebSocket backpressure:** drop high-frequency pushes when `bufferedAmount > 256KB`; terminate stuck clients
- **Starve recovery:** watchdog sheds backpressured clients; after 5 consecutive lag/RSS pressure ticks → `process.exit(2)` for service restart
- **BIT / health upgrades:**
  - `process.lag` — fail if event-loop lag > 2000 ms
  - `process.rss` — fail if RSS ≥ 512 MB
  - `http.ui` — local `GET /` must return 2xx within 2 s
  - `/health` status is `down` under process starvation (serial-only issues stay `degraded`)
- Console log filter quiets high-frequency telemetry noise

## Inherited from v1.1.0

- 2D pan pad + vertical tilt rail (console + widget)
- Soft tilt limits ±50°; home settle band ±1.5°
- Sector presets A/B/C × Low / Level / High
- Widget opens with RS-485 offline; Windows pip-shell overlay + HKLM Run autostart

## Build commands

```powershell
.\installers\windows\build.ps1 -Version 1.1.1 -SkipNpmInstall
.\installers\linux\package.ps1 -Version 1.1.1 -SkipBuild
.\installers\linux\build-guide.ps1
```

## Verification checklist

- [x] Fresh server serves `GET /` in milliseconds; RSS ~60–80 MB; lag ~0
- [x] BIT reports `process.lag` / `process.rss` / `http.ui` PASS
- [ ] `SPECTRE-Setup.exe` contains `pip-shell\node_modules\electron\dist\electron.exe`
- [ ] Fresh install: service on `:9000`, widget overlay, Start Menu shortcuts, logon autostart
