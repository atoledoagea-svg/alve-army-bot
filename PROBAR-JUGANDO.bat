@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Miniliga - quien esta jugando
echo.
echo  Voy a preguntarle a Steam quien tiene el Dota abierto
echo  y mandar la lista al grupo.
echo.
node bot.js --probar-jugando
pause
