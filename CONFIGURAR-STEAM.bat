@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Miniliga - vincular la cuenta de Steam bot
echo.
echo  Voy a conectar la cuenta de Steam del bot.
echo  Si Steam pide un codigo de Steam Guard, escribilo aca.
echo.
echo  (Antes edita config.json y pone steam_usuario y steam_password)
echo.
node bot.js --probar-jugando
pause
