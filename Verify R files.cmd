@echo off
rem Verifies .russ files with the console's own toolchain (Node, no Python).
rem Drag .russ files onto this file, or run: "Verify R files.cmd" plume-r1.russ
set "NODE=C:\Users\russe\Desktop\bytefoundry-0.99.2-win64\node-v22.23.4-win-x64\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0tools\verify_r.mjs" %*
pause
