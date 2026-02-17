@echo off
setlocal EnableDelayedExpansion

set SCRIPT_DIR=%~dp0
set ROOT_DIR=%SCRIPT_DIR%..

rem Parse arguments
set BUNDLE_ARGS=
set MAKE_ZIP=0
:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="/deb" set "BUNDLE_ARGS=%BUNDLE_ARGS% --bundles deb" & shift & goto :parse_args
if /i "%~1"=="/msi" set "BUNDLE_ARGS=%BUNDLE_ARGS% --bundles msi" & shift & goto :parse_args
if /i "%~1"=="/nsis" set "BUNDLE_ARGS=%BUNDLE_ARGS% --bundles nsis" & shift & goto :parse_args
if /i "%~1"=="/zip" set "MAKE_ZIP=1" & shift & goto :parse_args
echo Unknown argument: %~1
echo Usage: build.bat [/deb] [/msi] [/nsis] [/zip]
exit /b 1
:args_done

rem Clean old build artifacts
echo === Cleaning old build ===
if exist "%SCRIPT_DIR%build\release\bundle" rmdir /s /q "%SCRIPT_DIR%build\release\bundle"
if exist "%SCRIPT_DIR%binaries" rmdir /s /q "%SCRIPT_DIR%binaries"
if exist "%SCRIPT_DIR%icons" rmdir /s /q "%SCRIPT_DIR%icons"

rem Generate icons from SVG
echo === Generating icons ===
if not exist "%SCRIPT_DIR%icons" mkdir "%SCRIPT_DIR%icons"
magick -background none -size 32x32 "%ROOT_DIR%\frontend\static\favicon.svg" "%SCRIPT_DIR%icons\32x32.png"
magick -background none -size 128x128 "%ROOT_DIR%\frontend\static\favicon.svg" "%SCRIPT_DIR%icons\128x128.png"
magick -background none -size 256x256 "%ROOT_DIR%\frontend\static\favicon.svg" "%SCRIPT_DIR%icons\128x128@2x.png"
magick -background none -size 256x256 "%ROOT_DIR%\frontend\static\favicon.svg" "%SCRIPT_DIR%icons\icon.png"
magick -background none -size 256x256 "%ROOT_DIR%\frontend\static\favicon.svg" "%SCRIPT_DIR%icons\icon.ico"
if errorlevel 1 goto :error

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
cargo tauri build %BUNDLE_ARGS%
if errorlevel 1 goto :error

rem Move and rename MSI and NSIS bundles to bundle root (add platform to name)
	for /f "tokens=2 delims=: \t" %%v in ('findstr /c:"\"version\"" "%SCRIPT_DIR%tauri.conf.json"') do set "BVERSION=%%~v"
	set "BVERSION=!BVERSION:,=!"
	set "BARCH="
	for /f "tokens=1 delims=-" %%a in ("%TARGET%") do set "BARCH=%%a"
if exist "%SCRIPT_DIR%build\release\bundle\msi\*.msi" (
	for %%f in ("%SCRIPT_DIR%build\release\bundle\msi\*.msi") do (
		move /y "%%f" "%SCRIPT_DIR%build\release\bundle\LiberShare_!BVERSION!_win_!BARCH!.msi" >nul
	)
	rmdir /q "%SCRIPT_DIR%build\release\bundle\msi" 2>nul
)
if exist "%SCRIPT_DIR%build\release\bundle\nsis\*.exe" (
	for %%f in ("%SCRIPT_DIR%build\release\bundle\nsis\*.exe") do (
		move /y "%%f" "%SCRIPT_DIR%build\release\bundle\LiberShare_!BVERSION!_win_!BARCH!_setup.exe" >nul
	)
	rmdir /q "%SCRIPT_DIR%build\release\bundle\nsis" 2>nul
)

rem Create ZIP bundle if requested
if "%MAKE_ZIP%"=="1" (
	echo === Creating ZIP bundle ===
	set "ZIP_DIR=%SCRIPT_DIR%build\release\bundle\zip\LiberShare"
	if exist "%SCRIPT_DIR%build\release\bundle\zip" rmdir /s /q "%SCRIPT_DIR%build\release\bundle\zip"
	mkdir "!ZIP_DIR!"
	mkdir "!ZIP_DIR!\binaries"
	copy /y "%SCRIPT_DIR%build\release\LiberShare.exe" "!ZIP_DIR!\LiberShare.exe"
	copy /y "%SCRIPT_DIR%binaries\lish-backend-%TARGET%.exe" "!ZIP_DIR!\binaries\lish-backend-%TARGET%.exe"
	powershell -Command "Compress-Archive -Path '!ZIP_DIR!' -DestinationPath '%SCRIPT_DIR%build\release\bundle\LiberShare_!BVERSION!_win_!BARCH!.zip' -CompressionLevel Optimal -Force"
	rmdir /s /q "%SCRIPT_DIR%build\release\bundle\zip"
	if errorlevel 1 goto :error
)

echo === Build complete ===
echo Output: %SCRIPT_DIR%build\release\bundle\
goto :end

:error
echo Build failed!
exit /b 1

:end
endlocal
