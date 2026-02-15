@echo off
if exist build rmdir /s /q build
bun i --frozen-lockfile
mkdir build
bun build --compile src/app.ts --outfile build\lish-backend.exe
