@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem Hermes supports relocating its data dir (and named profiles) via HERMES_HOME.
rem On native Windows the default lives under %LOCALAPPDATA%\hermes; ~/.hermes is
rem the Linux/WSL layout, kept here as a fallback for older installs.
if defined HERMES_HOME (
  set "HERMESHOME=%HERMES_HOME%"
) else if exist "%LOCALAPPDATA%\hermes\.env" (
  set "HERMESHOME=%LOCALAPPDATA%\hermes"
) else (
  set "HERMESHOME=%USERPROFILE%\.hermes"
)
set "ENVFILE=!HERMESHOME!\.env"

if not exist "%ENVFILE%" (
  echo Could not find %ENVFILE%
  echo Hermes Browser Extension needs API_SERVER_KEY from your Hermes .env file.
  pause
  exit /b 1
)

set "KEY="
for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b "API_SERVER_KEY=" "%ENVFILE%"`) do set "KEY=%%B"

if not defined KEY (
  echo API_SERVER_KEY was not found in %ENVFILE%
  echo Run Hermes gateway/API setup first, then try again.
  pause
  exit /b 1
)

<nul set /p "=!KEY!" | clip
echo Hermes Browser Extension API key copied to clipboard.
echo Paste it into the extension settings API key field, then click Test connection.
pause
