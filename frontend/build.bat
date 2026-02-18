@echo off
if exist build rmdir /s /q build
bun i --frozen-lockfile
bun --bun run build
