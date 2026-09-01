@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ALVE ARMY - traer la sesion del bot viejo

echo.
echo  Esto trae tu configuracion y tu sesion de WhatsApp desde la carpeta
echo  del bot viejo (la del miniliga-whatsapp.exe), asi NO tenes que volver
echo  a escanear el QR ni elegir el grupo.
echo.
echo  Arrastra aca la carpeta vieja y apreta Enter:
set /p VIEJA=

set VIEJA=%VIEJA:"=%
if not exist "%VIEJA%\config.json" (
  echo.
  echo  En esa carpeta no hay ningun config.json. Fijate que sea la carpeta
  echo  donde esta miniliga-whatsapp.exe y proba de nuevo.
  echo.
  pause
  exit /b 1
)

copy /y "%VIEJA%\config.json" config.json >nul
if exist "%VIEJA%\sesion-whatsapp" (
  xcopy /e /i /y /q "%VIEJA%\sesion-whatsapp" sesion-whatsapp >nul
  echo  - sesion de WhatsApp copiada: no hace falta escanear el QR
) else (
  echo  - no habia sesion de WhatsApp, la primera vez te pide el QR
)
for %%A in (partidas-vistas.json ultimo-recap.json quien-es-quien.json sesion-steam.json) do (
  if exist "%VIEJA%\%%A" copy /y "%VIEJA%\%%A" %%A >nul
)
echo  - configuracion y estado copiados
echo.
echo  LISTO. Ya podes borrar la carpeta vieja y arrancar con INICIAR.bat
echo.
pause
