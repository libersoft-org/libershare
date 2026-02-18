#!/bin/sh

VITE_CLIENT_PATH_BASE="$1"
[ -d "./build/" ] && rm -r build
bun i --frozen-lockfile
VITE_CLIENT_PATH_BASE=$VITE_CLIENT_PATH_BASE bun --bun run build

# Copy country flag SVGs to build output
if [ -d "node_modules/country-flags/svg" ] && [ -d "build" ]; then
	mkdir -p build/flags
	cp node_modules/country-flags/svg/*.svg build/flags/
fi
