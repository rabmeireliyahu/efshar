@echo off
chcp 65001 >nul
rem  SHALOM_BAIT_WHATSAPP_SETUP.bat - doble click, UNA vez, en la carpeta del robot
rem  (C:\robotwhats, donde esta robot_whatsapp.js). Deja a Shalom Bait saliendo 1 vez por
rem  semana (lunes) con Apple + Spotify + audio. Despues cierra y abre la ventana del ROBOT.
title OTZAR - Shalom Bait: preparar robot de WhatsApp
color 0A
cd /d "%~dp0"
set PYTHONUTF8=1
python "%~dp0shalom_bait_whatsapp_setup.py"
echo.
pause
