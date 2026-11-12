; SPECTRE — Windows all-users installer (NSIS)
;
; Build (from repo root, after staging payload):
;   makensis /DPRODUCT_VERSION=1.0.0 installers\windows\Spectre.nsi
;
; Expects staged tree at release\windows\payload-clean\ containing:
;   server\dist\, web\dist\, pip-shell\, node_modules\, package.json, spectre.cmd, install.ps1

!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "1.1.6"
!endif

!define PRODUCT_NAME "SPECTRE"
!define PRODUCT_PUBLISHER "SPECTRE"
!define PRODUCT_TAGLINE "SPECTRE pan/tilt pedestal controller"
!define PRODUCT_URL "http://127.0.0.1:9000/"
!define INSTALL_DIR "$PROGRAMFILES64\SPECTRE"
!define REG_UNINSTALL "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
!define REG_RUN "Software\Microsoft\Windows\CurrentVersion\Run"
!define TASK_NAME "SPECTRE"

Unicode true
RequestExecutionLevel admin
SetCompressor /SOLID lzma
Name "${PRODUCT_NAME}"
OutFile "..\..\release\SPECTRE-Setup.exe"
InstallDir "${INSTALL_DIR}"
InstallDirRegKey HKLM "${REG_UNINSTALL}" "InstallLocation"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey "FileDescription" "SPECTRE local pan/tilt web service"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "LegalCopyright" "${PRODUCT_TAGLINE}"
VIAddVersionKey "Comments" "${PRODUCT_TAGLINE}"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${If} ${RunningX64}
    SetRegView 64
  ${Else}
    MessageBox MB_ICONSTOP "SPECTRE requires 64-bit Windows."
    Abort
  ${EndIf}
FunctionEnd

Section "SPECTRE" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"

  ; Stop previous instance if running
  nsExec::ExecToLog 'taskkill /F /IM node.exe /FI "WINDOWTITLE eq SPECTRE*"'
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name=''node.exe''\" | Where-Object { $$_.CommandLine -match ''SPECTRE|spectre|server\\\\dist\\\\src\\\\index'' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'

  File /r "..\..\release\windows\payload-clean\*.*"

  ; Branding / readme in install dir
  FileOpen $0 "$INSTDIR\BRANDING.txt" w
  FileWrite $0 "${PRODUCT_NAME}$\r$\n"
  FileWrite $0 "${PRODUCT_TAGLINE}$\r$\n"
  FileWrite $0 "Local web service: available on port 9000 (or saved httpPort)$\r$\n"
  FileClose $0

  ; Start Menu
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\SPECTRE Console.lnk" \
    "$INSTDIR\spectre.cmd" "" "$INSTDIR\spectre.cmd" 0 SW_SHOWMINIMIZED \
    "" "" "${PRODUCT_TAGLINE}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Open SPECTRE.lnk" \
    "${PRODUCT_URL}" "" "" 0
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall SPECTRE.lnk" \
    "$INSTDIR\Uninstall.exe"

  ; All-users autostart via HKLM Run (user logon) so Electron overlay can appear.
  ; Legacy SYSTEM ONSTART task is removed — it raced for :9000 and had no desktop.
  WriteRegStr HKLM "${REG_RUN}" "${PRODUCT_NAME}" \
    '"$INSTDIR\spectre.cmd"'
  nsExec::ExecToLog 'schtasks /Delete /TN "${TASK_NAME}" /F'

  ; Uninstaller
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${REG_UNINSTALL}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKLM "${REG_UNINSTALL}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKLM "${REG_UNINSTALL}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKLM "${REG_UNINSTALL}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${REG_UNINSTALL}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${REG_UNINSTALL}" "DisplayIcon" "$INSTDIR\spectre.cmd"
  WriteRegStr HKLM "${REG_UNINSTALL}" "Comments" "${PRODUCT_TAGLINE}"
  WriteRegDWORD HKLM "${REG_UNINSTALL}" "NoModify" 1
  WriteRegDWORD HKLM "${REG_UNINSTALL}" "NoRepair" 1

  ; Launch service, wait briefly for /health, then open browser
  Exec '"$INSTDIR\spectre.cmd"'
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "for ($$i=0; $$i -lt 30; $$i++) { Start-Sleep -Milliseconds 500; try { $$r = Invoke-WebRequest -Uri ''http://127.0.0.1:9000/health'' -UseBasicParsing -TimeoutSec 1; if ($$r.StatusCode -eq 200) { exit 0 } } catch {} }; exit 1"'
  ExecShell "open" "${PRODUCT_URL}"
SectionEnd

Section "Uninstall"
  SetRegView 64
  nsExec::ExecToLog 'schtasks /Delete /TN "${TASK_NAME}" /F'
  DeleteRegValue HKLM "${REG_RUN}" "${PRODUCT_NAME}"
  DeleteRegKey HKLM "${REG_UNINSTALL}"

  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name=''node.exe''\" | Where-Object { $$_.CommandLine -match ''SPECTRE|spectre|server\\\\dist\\\\src\\\\index'' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object { try { if ($$_.Path -match ''SPECTRE|pip-shell'') { Stop-Process -Id $$_.Id -Force -ErrorAction SilentlyContinue } } catch {} }"'

  RMDir /r "$SMPROGRAMS\${PRODUCT_NAME}"
  RMDir /r "$INSTDIR"
SectionEnd
