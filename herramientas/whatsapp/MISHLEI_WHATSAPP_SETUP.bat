@echo off
chcp 65001 >nul
title MISHLEI - preparar robot de WhatsApp
cd /d "%~dp0"
set PYTHONUTF8=1
if not exist "robot_whatsapp.js" (
  echo  !! Este boton tiene que estar en la MISMA carpeta que robot_whatsapp.js y ANUNCIAR.bat
  echo     Carpeta actual: %CD%
  pause
  exit /b
)
python "%~dp0mishlei_whatsapp_setup.py"
echo.
pause
