@echo off
rem  MISHLEI_PREPARAR.bat - doble click: convierte cada clase a mp3
rem  en C:\OTZAR\efshar\mishlei_listo con los titulos Mishlei 1, 2, 3...
rem  Corre primero MISHLEI_REVISAR y revisa mishlei_orden.txt.
setlocal
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
title OTZAR - Mishlei: preparar mp3
color 0A
python "%~dp0mishlei.py" preparar
echo.
pause
