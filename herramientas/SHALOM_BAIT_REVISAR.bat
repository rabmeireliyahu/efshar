@echo off
chcp 65001 >nul
rem  SHALOM_BAIT_REVISAR.bat - doble click: lee la carpeta del curso y muestra el orden,
rem  el tema y el Rab de cada clase, con el TITULO FINAL. No convierte ni sube nada.
rem  Si algo no cuadra se corrige en shalom_bait_orden.txt (Bloc de notas).
title OTZAR - Shalom Bait: revisar
color 0B
cd /d "%~dp0"
set PYTHONUTF8=1
python "%~dp0shalom_bait.py" revisar
echo.
pause
