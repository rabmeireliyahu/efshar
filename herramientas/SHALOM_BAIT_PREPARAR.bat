@echo off
chcp 65001 >nul
rem  SHALOM_BAIT_PREPARAR.bat - doble click: convierte cada clase a mp3 con su titulo
rem  final (Shalom Bait N - tema - Rab) en shalom_bait_listo y deja goteo.json y
rem  config.json listos. Corre primero SHALOM_BAIT_REVISAR. Se puede repetir sin miedo.
title OTZAR - Shalom Bait: preparar mp3
color 0A
cd /d "%~dp0"
set PYTHONUTF8=1
python "%~dp0shalom_bait.py" preparar
echo.
pause
