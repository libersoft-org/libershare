#!/bin/sh

VITE_CLIENT_PATH_BASE="$1"
[ -d "./build/" ] && rm -r build
bun i --frozen-lockfile
VITE_CLIENT_PATH_BASE=$VITE_CLIENT_PATH_BASE bun --bun run build
