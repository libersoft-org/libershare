@echo off
if exist build rmdir /s /q build
bun i --frozen-lockfile
bun --bun run build

rem Copy country flag SVGs to build output
if exist "node_modules\country-flags\svg" if exist "build" (
	if not exist "build\flags" mkdir "build\flags"
	copy /y "node_modules\country-flags\svg\*.svg" "build\flags\" >nul
)
