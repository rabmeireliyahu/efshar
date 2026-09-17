@echo off
rem  MISHLEI_REVISAR.bat - doble click: muestra el orden (Mishlei 1, 2, 3...)
rem  y que archivo tomaria de cada clase. NO sube ni convierte nada.
setlocal
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
title OTZAR - Mishlei: revisar orden
color 0B
python "%~dp0mishlei.py" revisar
echo.
pause
