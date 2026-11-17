@echo off
rem Plume XPU Console 1.4.0. Double-click to open Deer Valley. It needs Node.js or Python 3, whichever you have.
rem   "Start Plume.cmd"                       Deer Valley
rem   "Start Plume.cmd" index.html            the console (also simmy.html, show.html, verify.html)
rem   "Start Plume.cmd" valley.html photon    on VEC1 Design Photon, even when Node.js is installed
rem With Node.js it serves the pages on http://127.0.0.1:8788 (cross-origin isolated, so Wasm threads work) and opens
rem them in JA21 Blank Console if you have it, else in your default browser. Without Node.js the Python host serves
rem them: in Design Photon's verified window if Photon is found, else in your default browser.
setlocal EnableExtensions
set "HERE=%~dp0"
set "PAGE=%~1"
if not defined PAGE set "PAGE=valley.html"
set "MODE=%~2"
set "BLANK=C:\Users\russe\Downloads\unzipped\BLANK"
set "NODE=C:\Users\russe\Desktop\bytefoundry-0.99.2-win64\node-v22.23.4-win-x64\node.exe"
if not exist "%NODE%" set "NODE="
if not defined NODE for %%X in (node.exe) do if not "%%~$PATH:X"=="" set "NODE=%%~$PATH:X"
set "PY="
for %%P in (py.exe python.exe python3.exe) do if not defined PY for %%X in (%%P) do if not "%%~$PATH:X"=="" set "PY=%%~$PATH:X"
if /i "%MODE%"=="photon" goto python
if defined NODE goto node

:python
if not defined PY (
  echo Plume needs Node.js or Python 3, and neither was found.
  echo Install either one ^(nodejs.org or python.org^), then double-click this file again.
  pause
  endlocal & exit /b 1
)
"%PY%" -B "%HERE%host\plume_photon.py" --page "%PAGE%"
if errorlevel 4 goto failed
if errorlevel 3 "%PY%" -B "%HERE%host\plume_photon.py" --page "%PAGE%" --no-photon
if errorlevel 1 goto failed
endlocal & exit /b 0

:failed
pause
endlocal & exit /b 1

:node
start "Plume XPU server" /min "%NODE%" "%HERE%serve.mjs"
timeout /t 1 /nobreak >nul
if exist "%BLANK%\host\Start-Console.ps1" (
  powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%BLANK%\host\Start-Console.ps1" -StartUrl "http://127.0.0.1:8788/%PAGE%"
) else (
  start "" "http://127.0.0.1:8788/%PAGE%"
)
endlocal & exit /b 0
