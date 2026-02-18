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
if exist "%SCRIPT_DIR%icons" rmdir /s /q "%SCRIPT_DIR%icons"
cd /d "%SCRIPT_DIR%"
cargo clean 2>nul

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

for /f "tokens=*" %%i in ('rustc --print host-tuple') do set TARGET=%%i

rem Read product info from JSON and sync to tauri.conf.json
set "PRODUCT_JSON=%ROOT_DIR%\shared\src\product.json"
for /f "tokens=*" %%v in ('bun -e "process.stdout.write(require(process.argv[1]).version)" "%PRODUCT_JSON%"') do set "PRODUCT_VERSION=%%v"
for /f "tokens=*" %%n in ('bun -e "process.stdout.write(require(process.argv[1]).name)" "%PRODUCT_JSON%"') do set "PRODUCT_NAME=%%n"
for /f "tokens=*" %%d in ('bun -e "process.stdout.write(require(process.argv[1]).identifier)" "%PRODUCT_JSON%"') do set "PRODUCT_IDENTIFIER=%%d"
echo Product: !PRODUCT_NAME! v!PRODUCT_VERSION! (!PRODUCT_IDENTIFIER!)
bun -e "var f=require('fs'),p=require(process.argv[1]),t=process.argv[2],c=JSON.parse(f.readFileSync(t,'utf8'));c.productName=p.name;c.version=p.version;c.identifier=p.identifier;c.bundle.windows.nsis.startMenuFolder=p.name;f.writeFileSync(t,JSON.stringify(c,null,'\t')+'\n')" "%PRODUCT_JSON%" "%SCRIPT_DIR%tauri.conf.json"
bun -e "var f=require('fs'),v=process.argv[1],t=process.argv[2],s=f.readFileSync(t,'utf8').replace(/^version = \"[^\"]*\"/m,'version = \"'+v+'\"');f.writeFileSync(t,s)" "!PRODUCT_VERSION!" "%SCRIPT_DIR%Cargo.toml"

rem Build Tauri app
echo === Building Tauri app ===
cd /d "%SCRIPT_DIR%"
cargo tauri build %BUNDLE_ARGS%
if errorlevel 1 goto :error

rem Rename built binary to match product name if needed (cargo uses Cargo.toml [package].name)
if not exist "%SCRIPT_DIR%build\release\!PRODUCT_NAME!.exe" (
	for %%f in ("%SCRIPT_DIR%build\release\*.exe") do (
		ren "%%f" "!PRODUCT_NAME!.exe"
	)
)

rem Move and rename MSI and NSIS bundles to bundle root (add platform to name)
	set "BVERSION=!PRODUCT_VERSION!"
	set "BARCH="
	for /f "tokens=1 delims=-" %%a in ("%TARGET%") do set "BARCH=%%a"
if exist "%SCRIPT_DIR%build\release\bundle\msi\*.msi" (
	for %%f in ("%SCRIPT_DIR%build\release\bundle\msi\*.msi") do (
		move /y "%%f" "%SCRIPT_DIR%build\release\bundle\!PRODUCT_NAME!_!BVERSION!_win_!BARCH!.msi" >nul
	)
	rmdir /q "%SCRIPT_DIR%build\release\bundle\msi" 2>nul
)
if exist "%SCRIPT_DIR%build\release\bundle\nsis\*.exe" (
	for %%f in ("%SCRIPT_DIR%build\release\bundle\nsis\*.exe") do (
		move /y "%%f" "%SCRIPT_DIR%build\release\bundle\!PRODUCT_NAME!_!BVERSION!_win_!BARCH!_setup.exe" >nul
	)
	rmdir /q "%SCRIPT_DIR%build\release\bundle\nsis" 2>nul
)

rem Create ZIP bundle if requested
if "%MAKE_ZIP%"=="1" (
	echo === Creating ZIP bundle ===
	set "ZIP_DIR=%SCRIPT_DIR%build\release\bundle\zip"
	if exist "!ZIP_DIR!" rmdir /s /q "!ZIP_DIR!"
	mkdir "!ZIP_DIR!"
	copy /y "%SCRIPT_DIR%build\release\!PRODUCT_NAME!.exe" "!ZIP_DIR!\!PRODUCT_NAME!.exe"
	copy /y "%ROOT_DIR%\backend\build\lish-backend.exe" "!ZIP_DIR!\lish-backend.exe"
	powershell -Command "Compress-Archive -Path '!ZIP_DIR!\*' -DestinationPath '%SCRIPT_DIR%build\release\bundle\!PRODUCT_NAME!_!BVERSION!_win_!BARCH!.zip' -CompressionLevel Optimal -Force"
	rmdir /s /q "!ZIP_DIR!"
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
