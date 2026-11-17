@echo off
:: byte20.cmd - the byte20 pixel of Deer Valley in native cmd.exe arithmetic (law deer.valley.byte20/1).
:: SPDX-License-Identifier: GPL-3.0-only
::
::   byte20.cmd selftest             checks the integer kernels on fixed vectors
::   byte20.cmd decode FRAME.cmd N   decodes pixel N from a packed hex frame written by byte20_check
::
:: set /a works on signed 32-bit integers and its >> is arithmetic. The SWAR popcount of Theorem 2.1 of the
:: .cmd notes is exact anyway, because bit 31 of 0x55555555, 0x33333333 and 0x0F0F0F0F is 0. A packed hex
:: frame line holds 12 pixels (60 words) and 4 audit words: 512 hex digits.
:: Written to the same integer rules as src/byte20.js and tools/byte20/russl_byte20.h, whose self-tests run
:: in the release build; this file has not been run on Windows by its author.
setlocal EnableExtensions EnableDelayedExpansion
if /i "%~1"=="selftest" goto :selftest
if /i "%~1"=="decode" goto :decode
echo usage: byte20.cmd selftest ^| decode FRAME.cmd PIXEL
exit /b 2

:selftest
set /a "fail=0"
for %%v in ("0 0" "1 1" "-1 32" "0x7FFFFFFF 31" "0x80000000 1" "0x55555555 16" "0xF0F0F0F0 16" "305419896 13") do (
  for /f "tokens=1,2" %%a in (%%~v) do (
    call :popcnt32 %%a got
    if not "!got!"=="%%b" (echo FAIL popcnt32 %%a = !got!, expected %%b & set /a "fail+=1")
  )
)
call :xnor_dot32 12345 12345 d & if not "!d!"=="32" (echo FAIL xnor_dot32 p p = !d! & set /a "fail+=1")
call :xnor_dot32 7 -8 d & if not "!d!"=="-32" (echo FAIL xnor_dot32 7 ~7 = !d! & set /a "fail+=1")
call :mm_to_q16 1 q & if not "!q!"=="66" (echo FAIL mm_to_q16 1 = !q! & set /a "fail+=1")
call :gla_step 0 255 t & if not "!t!"=="31" (echo FAIL gla_step 0 255 = !t! & set /a "fail+=1")
call :gla_step 255 255 t & if not "!t!"=="255" (echo FAIL gla_step 255 255 = !t! & set /a "fail+=1")
call :field 0x4A002AC2 0 6 f & if not "!f!"=="2" (echo FAIL field & set /a "fail+=1")
call :field 0x87210E2E 31 1 f & if not "!f!"=="1" (echo FAIL field bit 31 & set /a "fail+=1")
if !fail! equ 0 (echo PASS  byte20 kernels: SWAR popcount incl. bit 31, XNOR dot, Q16.16, GLA, fields) else (echo FAIL  !fail! checks)
endlocal & exit /b %fail%

:: popcnt32 X OUT  - Theorem 2.1, four operations
:popcnt32
set /a "_v=%~1"
set /a "_v=_v - ((_v >> 1) & 0x55555555)"
set /a "_v=(_v & 0x33333333) + ((_v >> 2) & 0x33333333)"
set /a "_v=(_v + (_v >> 4)) & 0x0F0F0F0F"
set /a "_v=((_v * 0x01010101) >> 24) & 0x3F"
set "%~2=%_v%"
exit /b 0

:: xnor_dot32 P Q OUT  - <p, q> over {-1,+1}^32 = 2 popcnt(~(p ^ q)) - 32
:xnor_dot32
set /a "_x=~((%~1) ^ (%~2))"
call :popcnt32 %_x% _pc
set /a "%~3=(_pc << 1) - 32"
exit /b 0

:: mm_to_q16 MM OUT  - whole millimetres to Q16.16 metres, round half up (mm * 8192 / 125); MM < 262,000
:mm_to_q16
set /a "_t=%~1 * 8192, _q=_t / 125, _r=_t - _q * 125"
if %_t% lss 0 if not %_r%==0 set /a "_q-=1, _r+=125"
if %_r% geq 63 set /a "_q+=1"
set "%~2=%_q%"
exit /b 0

:: gla_step S V OUT  - the tied-gate step S' = (S (4096 - 512) + V 512) >> 12
:gla_step
set /a "%~3=((%~1) * 3584 + (%~2) * 512) >> 12"
exit /b 0

:: field X LO N OUT  - bits LO..LO+N-1 of X without sign extension
:field
if %~3 geq 32 (set /a "%~4=%~1" & exit /b 0)
set /a "%~4=((%~1) >> %~2) & ((1 << %~3) - 1)"
exit /b 0

:decode
if "%~3"=="" (echo usage: byte20.cmd decode FRAME.cmd PIXEL & exit /b 2)
set /a "pix=%~3, line=pix / 12, slot=pix %% 12"
set "ln=000%line%" & set "ln=!ln:~-4!"
call "%~2" || (echo cannot read %~2 & exit /b 2)
set "row=!B20_L%ln%!"
if not defined row (echo pixel %pix% is not in %~2 & exit /b 2)
for /l %%m in (0,1,4) do (
  set /a "off=(slot * 5 + %%m) * 8"
  for %%o in (!off!) do set "hex=!row:~%%o,8!"
  set /a "W%%m=0x!hex!"
)
call :field %W0% 0 16 z & if !z! geq 32768 set /a "z-=65536"
call :field %W0% 24 8 g
call :field %W2% 0 6 deer
call :field %W2% 14 3 wolves
call :field %W2% 24 8 trace
call :field %W3% 0 3 mat
call :field %W4% 16 12 d2
call :field %W4% 31 1 par
set /a "x=W0 ^ W1 ^ W2 ^ W3" & call :popcnt32 !x! pc & set /a "chk=pc & 1"
echo pixel %pix%  W0..W4 = %W0% %W1% %W2% %W3% %W4%
echo   height change !z! Q16 ticks, spread !g!/16 m, material !mat!
echo   deer !deer!, wolves !wolves!, GLA trace !trace!, D2 log12 !d2!
if "!par!"=="!chk!" (echo   parity bit agrees) else (echo   parity bit DISAGREES)
endlocal & exit /b 0
