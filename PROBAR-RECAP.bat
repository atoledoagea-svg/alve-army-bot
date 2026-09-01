@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Miniliga - prueba del resumen diario
echo.
echo  Voy a mandar al grupo el RESUMEN del dia de ayer.
echo  (El bot lo manda solo todos los dias a las 00:01.)
echo.
node bot.js --probar-recap
pause
