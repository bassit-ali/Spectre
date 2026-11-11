@echo off
REM SPECTRE service launcher
setlocal
title SPECTRE
cd /d "%~dp0"

if defined SPECTRE_NODE (
  set "NODE_EXE=%SPECTRE_NODE%"
) else if exist "%~dp0runtime\node.exe" (
  set "NODE_EXE=%~dp0runtime\node.exe"
) else if exist "%ProgramFiles%\nodejs\node.exe" (
  REM Reliable for Scheduled Task / SYSTEM at boot (PATH often empty)
  set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
) else if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
  set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
) else (
  where node >nul 2>&1
  if errorlevel 1 (
    echo [SPECTRE] Node.js not found. Install Node.js LTS or place node.exe in runtime\
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)

set "SPECTRE_WEB_DIR=%~dp0web\dist"
if not exist "%SPECTRE_WEB_DIR%\index.html" (
  echo [SPECTRE] Missing web\dist — rebuild with installers\windows\build.ps1
  exit /b 1
)

echo [SPECTRE] Starting local service on port 9000 (or saved httpPort)
"%NODE_EXE%" "%~dp0server\dist\src\index.js"
exit /b %ERRORLEVEL%
