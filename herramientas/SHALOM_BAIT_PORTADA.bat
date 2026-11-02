@echo off
chcp 65001 >nul
rem  SHALOM_BAIT_PORTADA.bat - ARRASTRA la imagen de la portada ENCIMA de este icono.
rem  La sube al repo como portada_shalombait.jpeg (la usan TODAS las clases de Shalom Bait).
title OTZAR - Shalom Bait: subir portada
cd /d "%~dp0"
set PYTHONUTF8=1
if "%~1"=="" (
  echo  Este boton se usa ARRASTRANDO la imagen de la portada ENCIMA del icono.
  echo.
  pause
  exit /b
)
python "%~dp0podcast_bot.py" portada "%~1" portada_shalombait.jpeg
echo.
pause
