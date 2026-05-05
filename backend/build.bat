@echo off
if exist build rmdir /s /q build
call bun i --frozen-lockfile
if errorlevel 1 exit /b 1

rem Pre-build verification: typecheck + unit tests must pass before producing artifacts.
rem Skip with SKIP_TESTS=1 only in emergencies (e.g. broken upstream tooling); CI must never set it.
if not "%SKIP_TESTS%"=="1" (
	call bun run typecheck
	if errorlevel 1 exit /b 1
	call bun run test
	if errorlevel 1 exit /b 1
)

mkdir build
call bun build --compile ./src/app.ts --outfile build\lish-backend.exe
if errorlevel 1 exit /b 1
mkdir build\lish
call bun build ./src/lish/checksum-worker.ts --target bun --outfile build\lish\checksum-worker.js
if errorlevel 1 exit /b 1

rem Patch PE subsystem from CONSOLE (3) to WINDOWS_GUI (2) to prevent console window
powershell -Command "$f='%~dp0build\lish-backend.exe'; $b=[IO.File]::ReadAllBytes($f); $pe=[BitConverter]::ToInt32($b,0x3C); $b[$pe+0x5C]=2; $b[$pe+0x5D]=0; [IO.File]::WriteAllBytes($f,$b)"
if errorlevel 1 exit /b 1
