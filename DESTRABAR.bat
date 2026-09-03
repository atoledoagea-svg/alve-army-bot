@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ALVE ARMY - destrabar el bot

echo.
echo  Esto pone el bot en la ultima version, aunque se haya trabado.
echo  La sesion de WhatsApp y el config.json NO se tocan: no estan en el repo.
echo.

taskkill /f /im node.exe >nul 2>nul

git fetch --all
git reset --hard origin/main
if errorlevel 1 (
  echo.
  echo  No pude actualizar. Mandale una foto de esta ventana a Agus.
  pause
  exit /b 1
)

call npm install --omit=dev --no-audit --no-fund

echo.
git log -1 --format="  Version: %%h %%s"
echo.
echo  Listo. Abriendo el bot...
echo.
timeout /t 3 >nul
start "" "%~dp0INICIAR.bat"
