@echo off
rem stop.bat - pembungkus tipis; logikanya ada di scripts\run\stop.mjs
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo [GAGAL] Node.js belum terpasang atau tidak ada di PATH. Pasang dari https://nodejs.org lalu ulangi.
  set RC=1
  goto :end
)
node "scripts\run\stop.mjs" %*
set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
  echo.
  echo Berhenti karena ada error ^(kode %RC%^). Baca pesan di atas.
)
:end
if not defined BIOCARE_NOPAUSE pause
exit /b %RC%
