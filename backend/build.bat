@echo off
if exist build rmdir /s /q build
call bun i --frozen-lockfile
if errorlevel 1 exit /b 1
mkdir build
call bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-package-json --no-compile-autoload-tsconfig src/network-helper.ts --outfile build\lish-network-helper.exe
if errorlevel 1 exit /b 1
call bun scripts\set-windows-gui-subsystem.ts build\lish-network-helper.exe
if errorlevel 1 exit /b 1
for /f "tokens=*" %%h in ('node -e "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "%~dp0build\lish-network-helper.exe"') do set "HELPER_HASH=%%h"
if not defined HELPER_HASH exit /b 1
call bun build --compile src/app.ts --outfile build\lish-backend.exe --define LISH_NETWORK_HELPER_SHA256=\"%HELPER_HASH%\"
if errorlevel 1 exit /b 1
call bun scripts\set-windows-gui-subsystem.ts build\lish-backend.exe
if errorlevel 1 exit /b 1
