@echo off
if exist build rmdir /s /q build
call bun i --frozen-lockfile
if errorlevel 1 exit /b 1
call bun --bun run build
if errorlevel 1 exit /b 1
