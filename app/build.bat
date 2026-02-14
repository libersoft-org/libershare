@echo off
setlocal

set SCRIPT_DIR=%~dp0
set ROOT_DIR=%SCRIPT_DIR%..

rem Build frontend
echo === Building frontend ===
cd /d "%ROOT_DIR%\frontend"
call build.bat
if errorlevel 1 goto :error

rem Build backend
echo === Building backend ===
cd /d "%ROOT_DIR%\backend"
call build.bat
if errorlevel 1 goto :error

rem Copy backend binary with target triple
echo === Preparing sidecar ===
for /f "tokens=*" %%i in ('rustc --print host-tuple') do set TARGET=%%i
if not exist "%SCRIPT_DIR%binaries" mkdir "%SCRIPT_DIR%binaries"
copy /y "%ROOT_DIR%\backend\build\lish-backend.exe" "%SCRIPT_DIR%binaries\lish-backend-%TARGET%.exe"
echo Copied lish-backend as lish-backend-%TARGET%.exe

rem Build Tauri app
echo === Building Tauri app ===
cd /d "%SCRIPT_DIR%"
cargo tauri build
if errorlevel 1 goto :error

echo === Build complete ===
echo Output: %SCRIPT_DIR%build\release\bundle\
goto :end

:error
echo Build failed!
exit /b 1

:end
endlocal
