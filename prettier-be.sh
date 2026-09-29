#!/bin/sh
# Format the backend with the prettier version locked in backend/bun.lock — never npx, never a global
# install, so every machine and CI produce the same output. `--check` reports without writing.
set -e
case "${1:-}" in
	'') MODE=--write ;;
	--check) MODE=--check ;;
	*) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac
ROOT="$(cd "$(dirname "$0")" && pwd)"
PRETTIER="$ROOT/backend/node_modules/prettier/bin/prettier.cjs"
if [ ! -f "$PRETTIER" ]; then
	echo "prettier is not installed: run 'bun install --frozen-lockfile' in $ROOT/backend/" >&2
	exit 1
fi
cd "$ROOT/backend"
bun "$PRETTIER" $MODE "**/*.{js,ts,json}"
