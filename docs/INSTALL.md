# SPECTRE — Install Guide

**Version 1.1.4**

SPECTRE is a local pan/tilt controller for Pelco-D heads. It binds to **127.0.0.1:9000**, serves the web console, and optionally shows an always-on-top desktop widget.

| | |
|---|---|
| **Console** | http://127.0.0.1:9000/ |
| **Widget** | http://127.0.0.1:9000/widget.html |
| **WebSocket** | `ws://127.0.0.1:9000/ws` |

![SPECTRE web console](screenshots/console.png)

![SPECTRE floating widget](screenshots/widget.png)

---

## Ship artifacts (latest only)

| File | Platform | Role |
|------|----------|------|
| `SPECTRE-Setup.exe` | Windows x64 | **Recommended** all-users installer |
| `SPECTRE-windows-x64-v1.1.4.zip` | Windows x64 | Portable payload + `install.ps1` |
| `spectre-linux-x64.tar.gz` | Linux x86_64 | Extract + `sudo ./install.sh` |
| `spectre-linux-arm64.tar.gz` | Linux ARM64 / Pi | Same |
| `SPECTRE-Install-Guide.pdf` | All | This guide (printable) |

Install from these packages for day-to-day use. Building from source is only for developers.

---

## What the package ships vs what it cannot

Release packages are offline for the **app itself**. They include Node.js, npm production modules, serialport natives, the web UI, and Electron.

They **cannot** include a few OS / hardware pieces. Those stay the machine’s responsibility:

| Item | Why it is not in the archive | Who provides it |
|------|------------------------------|-----------------|
| **USB-serial driver** | Kernel/vendor driver for your dongle (CH340 / FTDI / CP210x). Shipping every vendor driver is wrong and often illegal without redistribution rights. | OS / adapter vendor |
| **Windows Admin rights** | All-users install under Program Files + logon autostart needs elevation. | You (Run as Administrator) |
| **Linux `systemd`** | Boot service management is part of the OS. SPECTRE only drops a unit file. | Distro (Pi OS, Ubuntu, Debian, …) |
| **Linux serial permission (`dialout` + udev)** | Device node ownership is OS policy. Installer *writes* udev rules and *tries* to add you to `dialout`, but a re-login is often required. | OS + one-time user step |
| **Desktop session (optional)** | Electron overlay needs a logged-on GUI. Headless boxes still use the browser widget. | Your login / display |
| **Pelco-D hardware** | Physical pan/tilt + cabling. | You |

**Not required on the target:** system Node.js, system npm, or a network download during install.

---

## OS / hardware setup (do this once)

### 1. USB-serial adapter driver

Without a working driver, Windows shows an unknown device / no `COMx`, and Linux may not create `/dev/ttyUSB*` or `/dev/ttyACM*`.

**Identify the chip** (printed on the dongle, Device Manager, or `lsusb` on Linux): common ones are **CH340/CH341**, **FTDI FT232**, **Silicon Labs CP210x**.

#### Windows

1. Plug the adapter in.
2. Open **Device Manager** → **Ports (COM & LPT)** (or **Other devices** if missing).
3. If you see a yellow warning / “USB Serial” unknown device:
   - Install the vendor driver for that chip (CH340, FTDI VCP, or CP210x), then unplug/replug.
4. Note the **COMx** number (e.g. `COM3`). That is what SPECTRE’s **Ports** list will show.
5. Optional check in PowerShell: `[System.IO.Ports.SerialPort]::GetPortNames()`

#### Linux / Raspberry Pi

Most Pi OS / Ubuntu / Debian kernels already include `ch341`, `ftdi_sio`, and `cp210x`.

```bash
# After plugging the adapter:
lsusb
ls -l /dev/ttyUSB* /dev/ttyACM* 2>/dev/null
dmesg | tail -n 20
```

You want a device like `/dev/ttyUSB0`. If nothing appears, install kernel modules / firmware for your distro, or use a known-good adapter.

### 2. Linux serial permission (`dialout`)

Even with a driver, opening the port fails with “Permission denied” unless your user can access the tty.

`sudo ./install.sh` already:

- Writes `/etc/udev/rules.d/99-spectre-usbserial.rules` for CH340 / FTDI / CP210x
- Runs `usermod -aG dialout <you>` when possible

**You must log out and log back in** (or reboot) after the first install so the new group applies.

```bash
groups                    # should list dialout
# If dialout is missing:
sudo usermod -aG dialout "$USER"
# then log out / in, unplug/replug the adapter
ls -l /dev/ttyUSB0        # expect group dialout, mode 0660-ish
```

### 3. Linux `systemd`

SPECTRE expects a normal systemd machine (Raspberry Pi OS, Ubuntu Server/Desktop, Debian, most modern Linux).

```bash
systemctl --version       # should print systemd
```

If you are on a non-systemd image, the tarball still runs manually with `/opt/spectre/spectre.sh`, but boot autostart via `spectre.service` will not apply.

### 4. Desktop overlay vs browser widget

| Goal | Need |
|------|------|
| Web console | Browser to http://127.0.0.1:9000/ — always |
| Floating always-on-top widget | Logged-on desktop session (Windows user logon / Linux `DISPLAY`) |
| Headless / SSH-only box | Use the browser widget URL from another machine is **not** default (service is localhost-only); use a local browser or keep overlay off |

### 5. Windows SmartScreen (unsigned Setup)

`SPECTRE-Setup.exe` is not code-signed. On a PC that trusts your build:

1. Double-click Setup → if SmartScreen appears, click **More info**.
2. Click **Run anyway**.
3. Approve the UAC elevation prompt (Administrator).

---

## Requirements (checklist)

### All platforms

- [ ] USB-serial **driver** working (COM / `/dev/ttyUSB*`)
- [ ] Pelco-D head powered, address known (usually **1**), RS-485 (or optional UDP) wired
- [ ] Release package from GitHub — **no** system Node/npm install

### Windows

- [ ] Windows 10/11 **x64**
- [ ] **Administrator** for Setup.exe / `install.ps1`
- [ ] Accept SmartScreen / UAC for trusted builds

### Linux

- [ ] **x86_64** or **aarch64** (Pi 4/5: prefer arm64 package)
- [ ] `sudo` + **systemd**
- [ ] User in **dialout** after install (re-login)
- [ ] GUI session only if you want the Electron overlay

---

## Windows install

### Recommended: Setup.exe

1. Run **`SPECTRE-Setup.exe` as Administrator**.
2. After install / logon, open **http://127.0.0.1:9000/**.
3. The desktop widget starts with the service when a user session is active.

What the installer does (all already inside the package — offline):

- Copies the app to `C:\Program Files\SPECTRE\`
- Ships production `node_modules` (fastify, serialport, ws, …)
- Ships **Node** under `runtime\node.exe`
- Ships **Electron** under `pip-shell\` for the overlay
- Creates Start Menu shortcuts
- Registers HKLM logon Run so the overlay can draw on the desktop
- Writes uninstall metadata under Programs and Features

> **SmartScreen:** the Setup binary is **unsigned**. On trusted builds choose *More info → Run anyway*.

### Portable ZIP

```powershell
# Elevated PowerShell
Expand-Archive SPECTRE-windows-x64-v1.1.4.zip -DestinationPath C:\Temp\spectre-payload
cd C:\Temp\spectre-payload
.\install.ps1
```

### Uninstall (Windows)

```powershell
# Elevated
.\installers\windows\uninstall-system.ps1
```

Or use **Apps → SPECTRE → Uninstall**.

---

## Linux / Raspberry Pi install

| Machine | Archive |
|---------|---------|
| Intel/AMD 64-bit PC | `spectre-linux-x64.tar.gz` |
| Raspberry Pi / ARM64 | `spectre-linux-arm64.tar.gz` |

Check with `uname -m` → `x86_64` or `aarch64`.

```bash
tar -xzf spectre-linux-x64.tar.gz   # or spectre-linux-arm64.tar.gz
cd spectre
sudo ./install.sh
```

Open **http://127.0.0.1:9000/**.

The installer (fully offline — no network/npm on the target):

- Installs to `/opt/spectre`
- Enables `spectre.service` (starts on boot)
- Starts the service immediately
- Uses bundled Node under `runtime/bin/node`
- Ships Electron under `pip-shell/` (restores execute bits; browser widget always works)
- Writes USB-serial udev rules and adds the installing user to `dialout` when possible

### Raspberry Pi notes

1. Prefer the **arm64** archive on 64-bit Raspberry Pi OS.
2. If serial fails after first install:

```bash
cd /opt/spectre
PATH="$PWD/runtime/bin:$PATH" npm rebuild serialport
sudo systemctl restart spectre.service
groups   # confirm dialout; re-login if just added
```

Typical USB-RS485 device: `/dev/ttyUSB0` (select it in the console port list).

### Cross-built archives

If the archive was built on a different CPU than the target (common when packaging on Windows):

```bash
cd /opt/spectre
npm rebuild serialport
sudo systemctl restart spectre.service
```

### Service control

```bash
sudo systemctl status spectre.service
sudo systemctl restart spectre.service
sudo systemctl stop spectre.service
journalctl -u spectre.service -f
```

### Uninstall (Linux)

```bash
sudo systemctl disable --now spectre.service
sudo rm -f /etc/systemd/system/spectre.service
sudo systemctl daemon-reload
sudo rm -rf /opt/spectre
```

---

## First run — connect the head

1. Confirm the USB-serial driver / dialout steps above are done.
2. Open **http://127.0.0.1:9000/** — header should show **SERVER: WS ONLINE**.
3. Plug the USB-serial adapter; refresh **Ports** in Hardware Link.
4. Select the port (e.g. `COM13` / `/dev/ttyUSB0`), baud **9600**, address **1**.
5. Click **Connect**. Ribbon should show link **ONLINE**.
6. Optional: **RUN SELF-TEST** to verify serial + encoder replies.
7. Use **HALT** before unplugging serial or powering the head down mid-move.

Soft tilt limits are **−50° … +50°**. Home settles within **±1.5°**.

---

## Troubleshooting (OS prerequisites)

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| No COM / no `/dev/ttyUSB*` | Missing USB-serial driver | Install vendor driver; see **OS / hardware setup** |
| Windows: yellow bang in Device Manager | Driver not installed | CH340 / FTDI / CP210x driver from vendor |
| Linux: `Permission denied` on serial | Not in `dialout` / stale session | `usermod -aG dialout $USER`, log out/in, replug |
| Linux: service won’t enable | No systemd | Use a systemd distro, or run `spectre.sh` manually |
| Overlay window missing | No desktop session | Log on locally, or use http://127.0.0.1:9000/widget.html |
| SmartScreen blocks Setup | Unsigned binary | *More info → Run anyway* on builds you trust |
| Port list empty in console | Driver/permission | Fix driver/dialout first, then refresh Ports |

---

## Safety

- Prefer **HALT** before reconnecting or power-cycling the pedestal.
- Soft limits are software only — not a substitute for mechanical stops.
- Service binds to **localhost** by default; do not expose `:9000` to untrusted networks.
- Moving heads can injure people and equipment — keep the sweep clear.

---
