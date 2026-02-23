@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1

set "SCRIPT_DIR=%~dp0"
set "ROOT_DIR=%SCRIPT_DIR%.."

rem ─── Help ─────────────────────────────────────────────────────────────────

if "%~1"=="/?" goto :show_help
if "%~1"=="--help" goto :show_help
if "%~1"=="-h" goto :show_help
goto :skip_help

:show_help
echo Usage: %~nx0 [--os OS...] [--target ARCH...] [--format FMT...] [--compress LEVEL] [--help]
echo.
echo Options:
echo   --os        Operating systems to build for (combinable):
echo                 linux, windows, macos, all
echo               Default: all
echo.
echo   --target    CPU architectures to build for (combinable):
echo                 x86_64, aarch64, all
echo               Default: all
echo               'all' on Windows = x86_64 + aarch64
echo.
echo   --format    Output package formats (combinable):
echo                 Linux:   deb, rpm, pacman, appimage, zip
echo                 Windows: nsis, msi, zip
echo               Default: all (= all valid formats for chosen OS)
echo.
echo   --compress  Compression level (default: mid):
echo                 min  = fast   (xz -1e / ZIP Fastest)
echo                 mid  = balanced (xz -6e / ZIP Optimal)
echo                 max  = smallest (xz -9e / ZIP SmallestSize)
echo.
echo   --docker-rebuild  Force rebuild of the Docker image
echo.
echo   --help      Show this help
echo.
echo Examples:
echo   %~nx0
echo   %~nx0 --os windows --target x86_64 --format nsis zip
echo   %~nx0 --os linux windows --target all --format all
echo   %~nx0 --os linux --target x86_64 --format deb rpm
echo.
echo Notes:
echo   - Linux builds run inside Docker (requires Docker Desktop).
echo   - macOS builds require a macOS host (skipped on Windows).
echo   - 'all' cannot be combined with other values in the same flag.
echo   - aarch64 builds require Bun ARM64 support (Bun 1.4.0+).
exit /b 0

:skip_help

rem ─── Parse arguments ──────────────────────────────────────────────────────

set "OS_LIST="
set "TARGET_LIST="
set "FORMAT_LIST="
set "COMPRESS_LEVEL=mid"
set "DOCKER_REBUILD=0"
set "MODE="

:parse_args
if "%~1"=="" goto :args_done
if "%~1"=="--os" ( set "MODE=os" & shift & goto :parse_args )
if "%~1"=="--target" ( set "MODE=target" & shift & goto :parse_args )
if "%~1"=="--format" ( set "MODE=format" & shift & goto :parse_args )
if "%~1"=="--compress" ( set "MODE=compress" & shift & goto :parse_args )
if "%~1"=="--docker-rebuild" ( set "DOCKER_REBUILD=1" & shift & goto :parse_args )
if "%~1"=="--help" goto :show_help
if "%~1"=="-h" goto :show_help

if "!MODE!"=="os" (
    set "OS_LIST=!OS_LIST! %~1"
    shift & goto :parse_args
)
if "!MODE!"=="target" (
    set "TARGET_LIST=!TARGET_LIST! %~1"
    shift & goto :parse_args
)
if "!MODE!"=="format" (
    set "FORMAT_LIST=!FORMAT_LIST! %~1"
    shift & goto :parse_args
)
if "!MODE!"=="compress" (
    set "COMPRESS_LEVEL=%~1"
    set "MODE="
    shift & goto :parse_args
)
echo Error: Unknown argument '%~1'
echo Use --help for usage.
exit /b 1

:args_done

rem ─── Defaults ─────────────────────────────────────────────────────────────

if "!OS_LIST!"=="" set "OS_LIST=all"
if "!TARGET_LIST!"=="" set "TARGET_LIST=all"
if "!FORMAT_LIST!"=="" set "FORMAT_LIST=all"

rem ─── Resolve compression level ────────────────────────────────────────────

if "!COMPRESS_LEVEL!"=="min" ( set "ZIP_PS_LEVEL=Fastest" )
if "!COMPRESS_LEVEL!"=="mid" ( set "ZIP_PS_LEVEL=Optimal" )
if "!COMPRESS_LEVEL!"=="max" ( set "ZIP_PS_LEVEL=SmallestSize" )
if "!ZIP_PS_LEVEL!"=="" (
    echo Error: Invalid --compress value '!COMPRESS_LEVEL!' ^(use: min, mid, max^)
    exit /b 1
)

rem ─── Validate inputs ─────────────────────────────────────────────────────

rem Validate OS values
for %%o in (!OS_LIST!) do (
    if not "%%o"=="linux" if not "%%o"=="windows" if not "%%o"=="macos" if not "%%o"=="all" (
        echo Error: Unknown OS '%%o'. Valid: linux, windows, macos, all
        exit /b 1
    )
)

rem Validate target values
for %%t in (!TARGET_LIST!) do (
    if not "%%t"=="x86_64" if not "%%t"=="aarch64" if not "%%t"=="all" (
        echo Error: Unknown target '%%t'. Valid: x86_64, aarch64, all
        exit /b 1
    )
)

rem Validate format values
for %%f in (!FORMAT_LIST!) do (
    if not "%%f"=="deb" if not "%%f"=="rpm" if not "%%f"=="pacman" if not "%%f"=="appimage" if not "%%f"=="nsis" if not "%%f"=="msi" if not "%%f"=="zip" if not "%%f"=="all" (
        echo Error: Unknown format '%%f'. Valid: deb, rpm, pacman, appimage, nsis, msi, zip, all
        exit /b 1
    )
)

rem Check 'all' not combined with other values
call :check_all_combined "os" !OS_LIST! || exit /b 1
call :check_all_combined "target" !TARGET_LIST! || exit /b 1
call :check_all_combined "format" !FORMAT_LIST! || exit /b 1

rem ─── Expand 'all' ────────────────────────────────────────────────────────

set "_TMP=!OS_LIST!"
echo !_TMP! | findstr /i "all" >nul && set "OS_LIST=linux windows macos"

rem FORMAT_LIST 'all' is expanded per-OS in the build loop

rem ─── Validate formats for each requested OS ──────────────────────────────

if not "!FORMAT_LIST!"=="all" (
    for %%o in (!OS_LIST!) do (
        for %%f in (!FORMAT_LIST!) do (
            set "_fmt_ok=0"
            if "%%f"=="zip" set "_fmt_ok=1"
            if "%%o"=="linux" (
                if "%%f"=="deb" set "_fmt_ok=1"
                if "%%f"=="rpm" set "_fmt_ok=1"
                if "%%f"=="pacman" set "_fmt_ok=1"
                if "%%f"=="appimage" set "_fmt_ok=1"
            )
            if "%%o"=="windows" (
                if "%%f"=="nsis" set "_fmt_ok=1"
                if "%%f"=="msi" set "_fmt_ok=1"
            )
            if "!_fmt_ok!"=="0" (
                echo Error: Format '%%f' is not valid for OS '%%o'
                exit /b 1
            )
        )
    )
)

rem ─── Detect host ──────────────────────────────────────────────────────────

set "HOST_OS=windows"
if "%PROCESSOR_ARCHITECTURE%"=="AMD64" ( set "HOST_ARCH=x86_64" ) else (
    if "%PROCESSOR_ARCHITECTURE%"=="ARM64" ( set "HOST_ARCH=aarch64" ) else (
        set "HOST_ARCH=x86_64"
    )
)

rem ─── Check prerequisites ─────────────────────────────────────────────────

rem Check if Windows builds are requested
set "_NEEDS_WINDOWS=0"
for %%o in (!OS_LIST!) do if "%%o"=="windows" set "_NEEDS_WINDOWS=1"
if "!_NEEDS_WINDOWS!"=="1" (
    where cargo >nul 2>&1 || ( echo Error: cargo/Rust is required. Install from https://rustup.rs & exit /b 1 )
    where bun >nul 2>&1 || ( echo Error: bun is required. Install from https://bun.sh & exit /b 1 )
    where magick >nul 2>&1 || ( echo Error: ImageMagick is required. Install from https://imagemagick.org & exit /b 1 )
    cargo tauri --version >nul 2>&1 || ( echo Error: cargo-tauri is required. Run: cargo install tauri-cli & exit /b 1 )
)

rem Check if Docker is needed (for Linux builds)
set "_NEEDS_DOCKER=0"
for %%o in (!OS_LIST!) do if "%%o"=="linux" set "_NEEDS_DOCKER=1"
if "!_NEEDS_DOCKER!"=="1" (
    where docker >nul 2>&1 || ( echo Error: Docker Desktop is required for Linux builds. & exit /b 1 )
)

rem ─── Build Docker image ──────────────────────────────────────────────────

set "DOCKER_IMAGE=libershare-builder"
if "!_NEEDS_DOCKER!"=="1" (
    if "!DOCKER_REBUILD!"=="1" (
        echo === Rebuilding Docker image ^(--docker-rebuild^) ===
        docker rmi "!DOCKER_IMAGE!" 2>nul
        docker build --network=host --no-cache -t "!DOCKER_IMAGE!" "%SCRIPT_DIR%"
    ) else (
        docker image inspect "!DOCKER_IMAGE!" >nul 2>&1 && (
            echo === Docker image !DOCKER_IMAGE! already exists ^(cached^) ===
        ) || (
            echo === Building Docker image ===
            echo     ^(first build may take a long time^)
            docker build --network=host -t "!DOCKER_IMAGE!" "%SCRIPT_DIR%"
        )
    )
)

rem ─── Clean old output ────────────────────────────────────────────────────

if exist "%SCRIPT_DIR%build\release\bundle" rmdir /s /q "%SCRIPT_DIR%build\release\bundle"
if exist "%SCRIPT_DIR%icons" rmdir /s /q "%SCRIPT_DIR%icons"
if exist "%ROOT_DIR%\frontend\build" rmdir /s /q "%ROOT_DIR%\frontend\build"
mkdir "%SCRIPT_DIR%build\release\bundle" 2>nul

rem ─── Build tracking ──────────────────────────────────────────────────────

set "_build_ok="
set "_build_fail="
set "_build_count=0"
set "_fail_count=0"
set "_total_start=0"
call :get_timestamp _total_start

rem ─── Iterate over OS × target combinations ───────────────────────────────

for %%o in (!OS_LIST!) do (
    set "_os=%%o"

    rem Expand target 'all' per-OS
    set "_eff_targets=!TARGET_LIST!"
    echo !_eff_targets! | findstr /i "all" >nul && set "_eff_targets=x86_64 aarch64"

    rem Skip macOS on Windows host
    if "!_os!"=="macos" (
        for %%t in (!_eff_targets!) do (
            set /a _build_count+=1
            set /a _fail_count+=1
            set "_build_fail=!_build_fail! !_os!/%%t"
            call :print_box "SKIPPED: OS=!_os!  ARCH=%%t  (requires macOS host)"
        )
    ) else (
        for %%t in (!_eff_targets!) do (
            set "_target=%%t"

            echo.
            call :print_box "Building: OS=!_os!  ARCH=!_target!"
            echo.

            set /a _build_count+=1
            set "_build_start=0"
            call :get_timestamp _build_start

            if "!_os!"=="linux" (
                call :do_docker_build "!_os!" "!_target!"
            ) else (
                call :do_build "!_os!" "!_target!"
            )
            set "_rc=!errorlevel!"

            set "_elapsed=0"
            call :elapsed_since !_build_start! _elapsed

            echo.
            if "!_rc!"=="0" (
                call :print_box "Done: OS=!_os!  ARCH=!_target!  ^(!_elapsed!^)"
                set "_build_ok=!_build_ok! !_os!/!_target!"
            ) else (
                call :print_box "FAILED: OS=!_os!  ARCH=!_target!  ^(!_elapsed!^)"
                set "_build_fail=!_build_fail! !_os!/!_target!"
                set /a _fail_count+=1
            )
        )
    )
)

rem ─── Build Summary ───────────────────────────────────────────────────────

echo.
set /a _ok_count=_build_count - _fail_count
call :print_box "Build Summary: !_ok_count! passed, !_fail_count! failed (!_build_count! total)"
echo.

if not "!_build_ok!"=="" (
    echo   Succeeded:
    for %%s in (!_build_ok!) do echo     + %%s
)

if not "!_build_fail!"=="" (
    echo   FAILED:
    for %%f in (!_build_fail!) do echo     - %%f
)

echo.
echo Output: %SCRIPT_DIR%build\release\bundle\
for /f "usebackq" %%f in (`dir /b "%SCRIPT_DIR%build\release\bundle\" 2^>nul`) do (
    for %%F in ("%SCRIPT_DIR%build\release\bundle\%%f") do (
        set "_fsize=%%~zF"
        set /a "_fmb=!_fsize! / 1048576"
        echo   %%f  ^(!_fmb! MB^)
    )
)

set "_total_elapsed=0"
call :elapsed_since !_total_start! _total_elapsed
echo.
echo Total time: !_total_elapsed!

if !_fail_count! gtr 0 exit /b 1
exit /b 0

rem ═══════════════════════════════════════════════════════════════════════════
rem  Functions
rem ═══════════════════════════════════════════════════════════════════════════

rem ─── do_docker_build <os> <arch> ───────────────────────────────────────────
rem Runs the build inside Docker (for Linux targets)

:do_docker_build
setlocal EnableDelayedExpansion
set "_os=%~1"
set "_arch=%~2"

rem Compose --format args for inner script
set "INNER_FORMAT_ARGS="
if not "!FORMAT_LIST!"=="" set "INNER_FORMAT_ARGS=--format !FORMAT_LIST!"

rem --init: tini as PID 1 forwards signals to the entire process group
rem exec: build script replaces sh, becoming tini's direct child
docker run --rm --init ^
    -v "%ROOT_DIR%:/workspace" ^
    -v "%USERPROFILE%\.cargo\registry:/root/.cargo/registry" ^
    -v "%USERPROFILE%\.cargo\git:/root/.cargo/git" ^
    -v "%USERPROFILE%\.cache\cargo-xwin:/root/.cache/cargo-xwin" ^
    -v "%USERPROFILE%\.bun\install\cache:/root/.bun/install/cache" ^
    -e APPIMAGE_EXTRACT_AND_RUN=1 ^
    "!DOCKER_IMAGE!" ^
    sh -c "cd /workspace/app && exec ./build.sh --docker-inner --inner-os !_os! --inner-arch !_arch! --compress !COMPRESS_LEVEL! !INNER_FORMAT_ARGS!"
set "_rc=!errorlevel!"
endlocal & exit /b %_rc%

rem ─── do_build <os> <arch> ─────────────────────────────────────────────────

:do_build
setlocal EnableDelayedExpansion
set "_os=%~1"
set "_arch=%~2"

rem Determine Rust target and Bun target
if "!_os!_!_arch!"=="windows_x86_64" (
    set "RUST_TARGET=x86_64-pc-windows-msvc"
    set "BUN_TARGET=bun-windows-x64"
) else if "!_os!_!_arch!"=="windows_aarch64" (
    set "RUST_TARGET=aarch64-pc-windows-msvc"
    set "BUN_TARGET=bun-windows-arm64"
) else (
    echo Error: Unsupported OS/arch: !_os!/!_arch!
    exit /b 1
)

rem Ensure Rust target is installed
rustup target add !RUST_TARGET! >nul 2>&1

rem ── Build icons ──
call :build_icons || exit /b 1

rem ── Build frontend ──
call :build_frontend || exit /b 1

rem ── Build backend ──
call :build_backend "!BUN_TARGET!" || exit /b 1

rem ── Sync product info ──
call :sync_product_info || exit /b 1

rem ── Expand format 'all' for Windows ──
set "_FMT=!FORMAT_LIST!"
echo !_FMT! | findstr /i "all" >nul && set "_FMT=nsis msi zip"

rem ── Build Tauri ──
set "MAKE_NSIS=0"
set "MAKE_MSI=0"
set "MAKE_ZIP=0"
for %%f in (!_FMT!) do (
    if "%%f"=="nsis" set "MAKE_NSIS=1"
    if "%%f"=="msi" set "MAKE_MSI=1"
    if "%%f"=="zip" set "MAKE_ZIP=1"
)

set "BUNDLE_ARGS="
if "!MAKE_NSIS!"=="1" if "!MAKE_MSI!"=="1" (
    set "BUNDLE_ARGS=--bundles nsis msi"
) else if "!MAKE_NSIS!"=="1" (
    set "BUNDLE_ARGS=--bundles nsis"
) else if "!MAKE_MSI!"=="1" (
    set "BUNDLE_ARGS=--bundles msi"
)

set "_tauri_start=0"
call :get_timestamp _tauri_start
echo === Building Tauri app ^(target: !RUST_TARGET!^) ===
cd /d "%SCRIPT_DIR%"
set "CARGO_PROFILE_RELEASE_CODEGEN_UNITS=%NUMBER_OF_PROCESSORS%"
cargo tauri build --target !RUST_TARGET! --config tauri.windows.conf.json !BUNDLE_ARGS!
if errorlevel 1 ( endlocal & exit /b 1 )
set "_tauri_elapsed=0"
call :elapsed_since !_tauri_start! _tauri_elapsed
echo === Tauri done ^(!_tauri_elapsed!^) ===

rem ── Output directory ──
set "BUILD_RELEASE_DIR=%SCRIPT_DIR%build\!RUST_TARGET!\release"
set "BUILD_OUTPUT_DIR=!BUILD_RELEASE_DIR!\bundle"
set "FINAL_DIR=%SCRIPT_DIR%build\release\bundle"

rem ── Move NSIS installer ──
if "!MAKE_NSIS!"=="1" (
    if exist "!BUILD_OUTPUT_DIR!\nsis\*.exe" (
        for %%f in ("!BUILD_OUTPUT_DIR!\nsis\*.exe") do (
            move /y "%%f" "!FINAL_DIR!\!PRODUCT_NAME!_!PRODUCT_VERSION!_windows_!_arch!_setup.exe" >nul
        )
        rmdir /q "!BUILD_OUTPUT_DIR!\nsis" 2>nul
    )
)

rem ── Move MSI installer ──
if "!MAKE_MSI!"=="1" (
    if exist "!BUILD_OUTPUT_DIR!\msi\*.msi" (
        for %%f in ("!BUILD_OUTPUT_DIR!\msi\*.msi") do (
            move /y "%%f" "!FINAL_DIR!\!PRODUCT_NAME!_!PRODUCT_VERSION!_windows_!_arch!.msi" >nul
        )
        rmdir /q "!BUILD_OUTPUT_DIR!\msi" 2>nul
    )
)

rem ── Create ZIP ──
if "!MAKE_ZIP!"=="1" call :build_zip

echo === Build complete: OS=!_os! ARCH=!_arch! ===
endlocal
exit /b 0

rem ─── build_icons ──────────────────────────────────────────────────────────

:build_icons
if exist "%SCRIPT_DIR%icons\icon.png" (
    echo === Icons already built ^(cached^) ===
    exit /b 0
)
set "_icons_start=0"
call :get_timestamp _icons_start
echo === Generating icons ===
set "SVG=%ROOT_DIR%\frontend\static\favicon.svg"
if not exist "%SCRIPT_DIR%icons" mkdir "%SCRIPT_DIR%icons"
magick -background none -size 32x32 "%SVG%" "%SCRIPT_DIR%icons\32x32.png"
magick -background none -size 128x128 "%SVG%" "%SCRIPT_DIR%icons\128x128.png"
magick -background none -size 256x256 "%SVG%" "%SCRIPT_DIR%icons\128x128@2x.png"
magick -background none -size 256x256 "%SVG%" "%SCRIPT_DIR%icons\icon.png"
magick -background none -size 256x256 "%SVG%" "%SCRIPT_DIR%icons\icon.ico"
if errorlevel 1 exit /b 1
set "_icons_elapsed=0"
call :elapsed_since !_icons_start! _icons_elapsed
echo === Icons done ^(!_icons_elapsed!^) ===
exit /b 0

rem ─── build_frontend ──────────────────────────────────────────────────────

:build_frontend
if exist "%ROOT_DIR%\frontend\build\index.html" (
    echo === Frontend already built ^(cached^) ===
    exit /b 0
)
set "_fe_start=0"
call :get_timestamp _fe_start
echo === Building frontend ===
cd /d "%ROOT_DIR%\frontend"
call build.bat
if errorlevel 1 exit /b 1
set "_fe_elapsed=0"
call :elapsed_since !_fe_start! _fe_elapsed
echo === Frontend done ^(!_fe_elapsed!^) ===
exit /b 0

rem ─── build_backend <bun_target> ──────────────────────────────────────────

:build_backend
setlocal EnableDelayedExpansion
set "BUN_TGT=%~1"
set "_be_start=0"
call :get_timestamp _be_start
echo === Building backend ^(target: !BUN_TGT!^) ===
cd /d "%ROOT_DIR%\backend"
if exist build rmdir /s /q build
bun i --frozen-lockfile
if errorlevel 1 ( endlocal & exit /b 1 )
mkdir build
bun build --compile --target !BUN_TGT! src/app.ts --outfile build\lish-backend.exe
if errorlevel 1 ( endlocal & exit /b 1 )
set "_be_elapsed=0"
call :elapsed_since !_be_start! _be_elapsed
echo === Backend done ^(!_be_elapsed!^) ===
endlocal
exit /b 0

rem ─── sync_product_info ───────────────────────────────────────────────────

:sync_product_info
set "PRODUCT_JSON=%ROOT_DIR%\shared\src\product.json"
for /f "tokens=*" %%v in ('bun -e "process.stdout.write(require(process.argv[1]).version)" "%PRODUCT_JSON%"') do set "PRODUCT_VERSION=%%v"
for /f "tokens=*" %%n in ('bun -e "process.stdout.write(require(process.argv[1]).name)" "%PRODUCT_JSON%"') do set "PRODUCT_NAME=%%n"
for /f "tokens=*" %%d in ('bun -e "process.stdout.write(require(process.argv[1]).identifier)" "%PRODUCT_JSON%"') do set "PRODUCT_IDENTIFIER=%%d"
echo Product: !PRODUCT_NAME! v!PRODUCT_VERSION! (!PRODUCT_IDENTIFIER!)
rem Sync tauri.conf.json
bun -e "var f=require('fs'),p=require(process.argv[1]),t=process.argv[2],c=JSON.parse(f.readFileSync(t,'utf8'));c.productName=p.name;c.mainBinaryName=p.name;c.version=p.version;c.identifier=p.identifier;c.bundle.windows.nsis.startMenuFolder=p.name;f.writeFileSync(t,JSON.stringify(c,null,'\t')+'\n')" "%PRODUCT_JSON%" "%SCRIPT_DIR%tauri.conf.json"
rem Sync Cargo.toml version
bun -e "var f=require('fs'),v=process.argv[1],t=process.argv[2],s=f.readFileSync(t,'utf8').replace(/^version = \"[^\"]*\"/m,'version = \"'+v+'\"');f.writeFileSync(t,s)" "!PRODUCT_VERSION!" "%SCRIPT_DIR%Cargo.toml"
rem Sync wix-fragment-debug.wxs
bun -e "var f=require('fs'),n=process.argv[1],s=f.readFileSync(process.argv[2],'utf8').replace(/\{\{product_name\}\}/g,n);f.writeFileSync(process.argv[2],s)" "!PRODUCT_NAME!" "%SCRIPT_DIR%wix-fragment-debug.wxs"
exit /b 0

rem ─── build_zip ────────────────────────────────────────────────────────────

:build_zip
echo === Creating ZIP bundle ===
set "ZIP_STAGING=!FINAL_DIR!\zip_staging"
if exist "!ZIP_STAGING!" rmdir /s /q "!ZIP_STAGING!"
mkdir "!ZIP_STAGING!"
copy /y "!BUILD_RELEASE_DIR!\!PRODUCT_NAME!.exe" "!ZIP_STAGING!\!PRODUCT_NAME!.exe" >nul
copy /y "%ROOT_DIR%\backend\build\lish-backend.exe" "!ZIP_STAGING!\lish-backend.exe" >nul
rem Create Debug.bat from template
powershell -Command "(Get-Content '%SCRIPT_DIR%bundle-scripts\Debug.bat' -Raw) -replace '\{\{product_name\}\}','!PRODUCT_NAME!' | Set-Content '!ZIP_STAGING!\Debug.bat' -NoNewline"
powershell -Command "Compress-Archive -Path '!ZIP_STAGING!\*' -DestinationPath '!FINAL_DIR!\!PRODUCT_NAME!_!PRODUCT_VERSION!_windows_!_arch!.zip' -CompressionLevel !ZIP_PS_LEVEL! -Force"
rmdir /s /q "!ZIP_STAGING!"
echo === ZIP done ===
exit /b 0

rem ─── check_all_combined <flag_name> <values...> ────────────────────────

:check_all_combined
setlocal EnableDelayedExpansion
set "_flag=%~1"
shift
set "_has_all=0"
set "_count=0"
:cac_loop
if "%~1"=="" goto :cac_done
set /a _count+=1
if "%~1"=="all" set "_has_all=1"
shift
goto :cac_loop
:cac_done
if "!_has_all!"=="1" if !_count! gtr 1 (
    echo Error: --!_flag! 'all' cannot be combined with other values
    endlocal & exit /b 1
)
endlocal
exit /b 0

rem ─── print_box <message> ──────────────────────────────────────────────────

:print_box
setlocal EnableDelayedExpansion
set "_msg=%~1"
call :strlen _msg _len
set "_border="
for /l %%i in (1,1,!_len!) do set "_border=!_border!="
echo +==!_border!==+
echo ^|  !_msg!  ^|
echo +==!_border!==+
endlocal
exit /b 0

rem ─── strlen <var_name> <result_var> ───────────────────────────────────────

:strlen
setlocal EnableDelayedExpansion
set "_str=!%~1!"
set "_l=0"
:strlen_loop
if not "!_str:~%_l%,1!"=="" ( set /a _l+=1 & goto :strlen_loop )
endlocal & set "%~2=%_l%"
exit /b 0

rem ─── get_timestamp <result_var> ───────────────────────────────────────────
rem Returns seconds since midnight (good enough for elapsed time)

:get_timestamp
setlocal EnableDelayedExpansion
for /f "tokens=1-3 delims=:." %%a in ("!TIME: =0!") do (
    set /a "_ts=%%a * 3600 + %%b * 60 + %%c"
)
endlocal & set "%~1=%_ts%"
exit /b 0

rem ─── elapsed_since <start_ts> <result_var> ────────────────────────────────

:elapsed_since
setlocal EnableDelayedExpansion
set "_start=%~1"
set "_now=0"
call :get_timestamp _now
set /a "_el=_now - _start"
if !_el! lss 0 set /a "_el+=86400"
if !_el! geq 60 (
    set /a "_m=_el / 60"
    set /a "_s=_el %% 60"
    set "_result=!_m!m !_s!s"
) else (
    set "_result=!_el!s"
)
endlocal & set "%~2=%_result%"
exit /b 0
