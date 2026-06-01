@echo off
chcp 65001 >nul
cd /d "%~dp0"

if "%1"=="" (
    echo.
    echo  +--------------------------------------------------+
    echo  ^|       GESTION RADARFUBAR                         ^|
    echo  +--------------------------------------------------+
    echo.
    echo  Comandos disponibles:
    echo.
    echo    gestion status         - Ver servidor y jugadores
    echo    gestion players        - Listar jugadores
    echo    gestion sessions       - Ver sesiones activas
    echo    gestion broadcast ^<msg^> - Enviar mensaje a todos
    echo    gestion ip             - Mostrar URL del servidor
    echo.
    echo  Si el servidor no esta en localhost:3000:
    echo    set SERVER=http://IP:3000
    echo    gestion status
    echo.
    goto end
)

node gestion.js %*
if %errorlevel% neq 0 (
    echo.
    echo  [ERROR] No se pudo ejecutar. Verifica:
    echo  - El servidor esta corriendo? (node server.js)
    echo  - Node.js esta instalado?  (where node)
)
:end
echo.
