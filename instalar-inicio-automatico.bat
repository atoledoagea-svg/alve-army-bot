@echo off
chcp 65001 >nul
set "DESTINO=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ALVE ARMY bot.lnk"
powershell -NoProfile -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%DESTINO%');" ^
  "$s.TargetPath = '%~dp0INICIAR.bat';" ^
  "$s.WorkingDirectory = '%~dp0';" ^
  "$s.Description = 'Bot de la LIGA ALVE ARMY (avisos al grupo de WhatsApp)';" ^
  "$s.Save()"
echo.
echo  Listo: el bot va a arrancar solo cuando prendas la PC.
echo  (Para desactivarlo, borra el acceso directo de la carpeta Inicio.)
echo.
pause
