@echo off
if exist build rmdir /s /q build
bun i --frozen-lockfile
mkdir build
bun build --compile src/app.ts --outfile build\lish-backend.exe

rem Patch PE subsystem from CONSOLE (3) to WINDOWS_GUI (2) to prevent console window
powershell -Command "$f='%~dp0build\lish-backend.exe'; $b=[IO.File]::ReadAllBytes($f); $pe=[BitConverter]::ToInt32($b,0x3C); $b[$pe+0x5C]=2; $b[$pe+0x5D]=0; [IO.File]::WriteAllBytes($f,$b)"
