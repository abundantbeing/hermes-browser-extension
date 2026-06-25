@echo off
setlocal EnableExtensions
pushd "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install Node 20+ or run from a shell where node is available.
  popd
  pause
  exit /b 1
)

node scripts\windows-setup.mjs %*
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
  echo.
  echo Hermes Browser Extension setup/update failed with exit code %EXITCODE%.
  echo You can still copy the API key manually with Copy_Hermes_Browser_API_Key.cmd.
  pause
)

popd
exit /b %EXITCODE%
