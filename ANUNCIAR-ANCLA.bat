@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ALVE ARMY - anunciar el ancla

echo Mandando el ancla del mes al grupo...
node bot.js --anunciar-ancla
echo.
pause
