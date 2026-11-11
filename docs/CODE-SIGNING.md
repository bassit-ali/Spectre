# Windows code signing (trusted installer)

SPECTRE’s `SPECTRE-Setup.exe` is an NSIS installer. Windows SmartScreen trusts it only when the **file is Authenticode-signed** with a certificate that chains to a Microsoft Trusted Root CA, and (for new publishers) after the **publisher identity builds download reputation**.

Self-signed certificates do **not** help public users. Signing is what turns “Unknown publisher / More info → Run anyway” into a normal UAC prompt over time.

## Realistic options (2025+)

| Option | Approx. cost | Region / who | SmartScreen | Best when |
|--------|--------------|--------------|-------------|-----------|
| **Azure Artifact Signing** (was “Trusted Signing”) | ~$10/mo | Orgs: US/CA/EU/UK · Individuals: US/CA | Reputation builds over releases — **not** instant | Recommended if you qualify — no USB token, CI-friendly |
| **OV code signing cert** (DigiCert, Sectigo, SSL.com, GlobalSign, …) | ~$150–400/yr | Worldwide | Same as above — reputation builds | You are outside Azure’s region, or prefer a classic CA |
| **EV code signing cert** | ~$400+/yr + hardware/HSM | Worldwide | **No longer** an instant SmartScreen bypass (since ~2024) | Only if a customer/policy still demands EV |
| **Microsoft Store (MSIX)** | Free Store re-sign | Worldwide | Clean Store install | You want Store distribution (different packaging) |
| **Self-signed / unsigned** | Free | — | Blocks / warns for public users | Dev only |

**Important:** Even a correctly signed Setup can show SmartScreen the **first** few times a new publisher appears. Keep the **same publisher name** across releases so reputation accumulates. EV no longer skips that.

Official overview: [Code signing options for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).

---

## What SPECTRE signs

Sign these after each Windows pack (SHA-256 + RFC3161 timestamp):

1. `release/SPECTRE-Setup.exe` — **required** (what users download)
2. Optional later: `pip-shell` Electron `electron.exe` inside the payload (reduces secondary warnings when the overlay starts)

The portable ZIP is not itself Authenticode-signed; users who expand it and run `install.ps1` still need to trust the scripts. Prefer **Setup.exe** for field installs.

---

## Path A — Azure Artifact Signing (recommended if eligible)

1. Create an Azure subscription and an **Artifact Signing** account + certificate profile (Public Trust).
2. Complete identity validation (a few business days).
3. Sign from CI or a Windows machine with the Artifact Signing / Trusted Signing tooling (`Invoke-TrustedSigning` / SignTool integration).
4. Timestamp with Microsoft’s service (e.g. `http://timestamp.acs.microsoft.com`).

GitHub Action pattern (conceptually):

```yaml
# After npm run pack:win produces release/SPECTRE-Setup.exe
- uses: azure/trusted-signing-action@v0   # name may migrate to artifact-signing
  with:
    azure-tenant-id: ${{ secrets.AZURE_TENANT_ID }}
    azure-client-id: ${{ secrets.AZURE_CLIENT_ID }}
    azure-client-secret: ${{ secrets.AZURE_CLIENT_SECRET }}
    endpoint: https://eus.codesigning.azure.net/
    trusted-signing-account-name: ${{ secrets.TS_ACCOUNT }}
    certificate-profile-name: ${{ secrets.TS_PROFILE }}
    files-folder: ${{ github.workspace }}/release
    files-folder-filter: SPECTRE-Setup.exe
    file-digest: SHA256
    timestamp-rfc3161: http://timestamp.acs.microsoft.com
    timestamp-digest: SHA256
```

Docs: [Artifact Signing integrations](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations).

---

## Path B — OV certificate + SignTool (works worldwide)

1. Buy an **OV Code Signing** cert from a CA in the Microsoft Trusted Root Program.
2. Modern CAs issue to a **hardware token / cloud HSM** (not a loose `.pfx` email). Follow their export/HSM instructions.
3. On the build PC install [Windows SDK](https://developer.microsoft.com/windows/downloads/windows-sdk/) so `signtool.exe` is available.
4. Sign Setup after NSIS:

```powershell
.\installers\windows\sign-setup.ps1 `
  -ExePath .\release\SPECTRE-Setup.exe `
  -PfxPath $env:SPECTRE_SIGN_PFX `
  -PfxPassword $env:SPECTRE_SIGN_PFX_PASSWORD
```

Or let `build.ps1` call it automatically when those env vars are set (see below).

Always use a **timestamp server** so the signature stays valid after the cert expires, e.g. DigiCert `http://timestamp.digicert.com`.

Verify:

```powershell
Get-AuthenticodeSignature .\release\SPECTRE-Setup.exe | Format-List *
```

`Status` should be `Valid`.

---

## Hook already in this repo

| File | Role |
|------|------|
| `installers/windows/sign-setup.ps1` | Signs one EXE with SignTool (PFX or certificate store) |
| `installers/windows/build.ps1` | After NSIS, runs sign if `SPECTRE_SIGN_PFX` (or `-Sign`) is set |

Environment variables (local or CI secrets — **never commit**):

| Variable | Meaning |
|----------|---------|
| `SPECTRE_SIGN_PFX` | Path to `.pfx` / `.p12` (if your CA still allows file-based) |
| `SPECTRE_SIGN_PFX_PASSWORD` | PFX password |
| `SPECTRE_SIGN_THUMBPRINT` | Optional: use a cert already in the Windows cert store instead of PFX |
| `SPECTRE_SIGN_TIMESTAMP_URL` | Optional override (default DigiCert) |

Azure Artifact Signing usually uses its own action/cmdlet instead of the PFX path; keep using that for cloud signing and still attach the signed `SPECTRE-Setup.exe` to the GitHub Release.

---

## Publisher checklist

1. Pick **Azure Artifact Signing** *or* **OV cert** (EV only if required).
2. Validate identity under the **legal name** you want users to see (“SPECTRE” / your org).
3. Wire signing into every Windows release build (same identity every time).
4. Upload only the **signed** `SPECTRE-Setup.exe` to GitHub Releases.
5. Expect early SmartScreen warnings until reputation builds; do not keep changing publisher names.
6. Update INSTALL/README when the published Setup is signed (drop “unsigned / Run anyway” as the primary path).

---

## What this does *not* replace

- Users still see **UAC** for an all-users Program Files install (expected).
- USB-serial drivers, dialout, etc. remain OS prerequisites ([INSTALL.md](INSTALL.md#os--hardware-setup-do-this-once)).
- Linux packages use a different trust model (distro packages / checksums); Authenticode is Windows-only.
