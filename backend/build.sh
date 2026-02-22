#!/bin/sh
set -e

# Parse arguments
BUN_TARGET=""
MODE=""
for arg in "$@"; do
	case "$arg" in
		--target) MODE="target" ;;
		*)
			case "$MODE" in
				target) BUN_TARGET="$arg"; MODE="" ;;
				*) echo "Unknown argument: $arg"; exit 1 ;;
			esac
			;;
	esac
done

[ -d "./build/" ] && rm -r build
mkdir -p build
bun i --frozen-lockfile

if [ -n "$BUN_TARGET" ]; then
	echo "Building backend for target: $BUN_TARGET"
	case "$BUN_TARGET" in
		*windows*) bun build --compile --target "$BUN_TARGET" src/app.ts --outfile build/lish-backend.exe ;;
		*)         bun build --compile --target "$BUN_TARGET" src/app.ts --outfile build/lish-backend ;;
	esac
else
	bun build --compile src/app.ts --outfile build/lish-backend
fi
