@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ALVE ARMY - bot de WhatsApp

:arrancar
where git >nul 2>nul
if not errorlevel 1 (
  git pull --ff-only >nul 2>nul
)
set ALVE_LANZADOR=1
node bot.js
set CODIGO=%ERRORLEVEL%

rem 42 = se actualizo solo y pide arrancar de nuevo
if "%CODIGO%"=="42" (
  echo.
  echo  Bot actualizado, arrancando de nuevo...
  echo.
  goto arrancar
)

rem 0 = lo cortaron a proposito (Ctrl+C)
if "%CODIGO%"=="0" goto fin

echo.
echo  El bot se corto solo (codigo %CODIGO%). Vuelvo a levantarlo en 15 segundos.
echo  Para cortarlo de verdad, cerra esta ventana.
echo.
timeout /t 15 >nul
goto arrancar

:fin
pause
