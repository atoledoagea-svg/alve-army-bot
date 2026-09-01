@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ALVE ARMY - actualizar

echo Bajando la ultima version...
git pull --ff-only
if errorlevel 1 (
  echo.
  echo  No se pudo actualizar. Mandale una foto de esto a Agus.
  pause
  exit /b 1
)
call npm install --omit=dev --no-audit --no-fund
echo.
echo  Actualizado. Tu sesion de WhatsApp quedo igual: no hay que escanear nada.
echo  Abri INICIAR.bat
echo.
pause
