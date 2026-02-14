@echo off
bun i --frozen-lockfile
if not exist build mkdir build
bun build --compile src/app.ts --outfile build\lish-backend.exe
