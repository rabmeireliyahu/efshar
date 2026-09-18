@echo off
chcp 65001 >nul
title MISHLEI - reparar robot de WhatsApp
cd /d "%~dp0"
set PYTHONUTF8=1
python "%~dp0mishlei_whatsapp_reparar.py"
echo.
pause
