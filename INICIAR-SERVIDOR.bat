@echo off
chcp 65001 >nul
echo.
echo +------------------------------------------------------+
echo |          RADARFUBAR - INICIANDO SERVIDOR              |
echo +------------------------------------------------------+
echo.

cd /d "%~dp0"

REM Verify Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js no esta instalado.
    echo Descarga desde: https://nodejs.org/
    pause
    exit /b 1
)

REM Install dependencies if needed
if not exist "node_modules" (
    echo Instalando dependencias...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Fallo al instalar dependencias.
        pause
        exit /b 1
    )
)

echo.
echo +------------------------------------------------------+
echo |  ABRE EN TU NAVEGADOR:                              |
echo +------------------------------------------------------+
echo |  http://localhost:3000                                |
echo +------------------------------------------------------+
echo.
echo Presiona Ctrl+C para detener el servidor
echo.

node server.js

echo.
echo [SERVIDOR DETENIDO]
echo.
pause
