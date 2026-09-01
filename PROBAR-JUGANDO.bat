@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ALVE ARMY - probar quien esta jugando
echo.
echo  Voy a mandar al grupo quien esta jugando ahora.
echo.
echo  Si el mensaje dice "en partida con ^<heroe^>", la cuenta de Steam
echo  del bot esta funcionando bien.
echo  Si solo dice "Con el Dota abierto", Steam no esta conectado o los
echo  jugadores no agregaron al bot / tienen los detalles del juego en privado.
echo.
node bot.js --probar-jugando
pause
