@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Miniliga - prueba de aviso al grupo
echo.
echo  Voy a mandar al grupo el aviso de la ULTIMA partida jugada.
echo  (Sirve para probar que todo funciona.)
echo.
node bot.js --probar-ultima
pause
