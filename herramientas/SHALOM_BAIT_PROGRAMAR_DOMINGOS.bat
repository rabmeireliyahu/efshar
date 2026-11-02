@echo off
chcp 65001 >nul
rem  SHALOM_BAIT_PROGRAMAR_DOMINGOS.bat - OPCIONAL: programa Windows para que SOLO suba
rem  la clase de la semana cada domingo a las 9:00 (la compu tiene que estar prendida con tu
rem  sesion abierta). Si ese domingo no estaba prendida, dale doble click a
rem  SHALOM_BAIT_SUBIR_SEMANA.bat en cuanto puedas; el robot manda la clase de lunes a jueves.
title OTZAR - Shalom Bait: programar los domingos
cd /d "%~dp0"
schtasks /Create /TN "OTZAR Shalom Bait domingo" /TR "\"%~dp0SHALOM_BAIT_SUBIR_SEMANA.bat\" auto" /SC WEEKLY /D SUN /ST 09:00 /F
echo.
if errorlevel 1 (
  echo  !! No pude programar la tarea. Corre este boton con click derecho: "Ejecutar como administrador".
) else (
  echo  OK: cada domingo 9:00 se sube la clase de la semana. El resultado queda en shalom_bait_domingo.log
  echo  Para quitarla:  schtasks /Delete /TN "OTZAR Shalom Bait domingo" /F
)
echo.
pause
