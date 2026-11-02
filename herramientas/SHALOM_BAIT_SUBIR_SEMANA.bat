@echo off
chcp 65001 >nul
rem  SHALOM_BAIT_SUBIR_SEMANA.bat - sube al feed la clase de ESTA semana (la siguiente
rem  sin publicar). Va los DOMINGOS; el LUNES, ANUNCIAR la manda a WhatsApp.
rem  No sube dos veces en la misma semana. Con el argumento "auto" (lo usa el
rem  programador de tareas) no pide tecla y deja el resultado en shalom_bait_domingo.log
title OTZAR - Shalom Bait: subir la clase de la semana
cd /d "%~dp0"
set PYTHONUTF8=1
if /i "%~1"=="auto" (
  echo ==== %DATE% %TIME% ==== >> "%~dp0shalom_bait_domingo.log"
  python "%~dp0shalom_bait.py" semana >> "%~dp0shalom_bait_domingo.log" 2>&1
  exit /b
)
python "%~dp0shalom_bait.py" semana
echo.
pause
