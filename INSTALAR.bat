@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ALVE ARMY - instalacion

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  FALTA NODE.JS
  echo  Descargalo de https://nodejs.org  ^(version LTS, siguiente-siguiente-terminar^)
  echo  Cuando termine, volve a abrir este archivo.
  echo.
  pause
  exit /b 1
)
where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo  FALTA GIT
  echo  Descargalo de https://git-scm.com/download/win  ^(siguiente-siguiente-terminar^)
  echo  Sin Git el bot igual funciona, pero no se actualiza solo.
  echo.
  pause
)

echo Instalando lo que necesita el bot (tarda un par de minutos)...
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo  Algo fallo instalando. Sacale una foto a esto y mandasela a Agus.
  pause
  exit /b 1
)

if not exist config.json (
  copy config.ejemplo.json config.json >nul
  echo.
  echo  ATENCION: te abro config.json en el Bloc de notas.
  echo  Pegale las claves que te paso Agus y guardalo ^(Ctrl+G^).
  echo  Sin eso el bot no arranca.
  echo.
  start /wait notepad config.json
)

echo.
echo  LISTO. Ahora abri INICIAR.bat
echo.
pause
