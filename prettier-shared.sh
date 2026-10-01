#!/bin/sh
# Format the shared package with the prettier version locked in the root bun.lock — never npx, never a global
# install, so every machine and CI produce the same output. `--check` reports without writing.
set -e
case "${1:-}" in
	'') MODE=--write ;;
	--check) MODE=--check ;;
	*) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac
ROOT="$(cd "$(dirname "$0")" && pwd)"
PRETTIER="$ROOT/node_modules/prettier/bin/prettier.cjs"
if [ ! -f "$PRETTIER" ]; then
	echo "prettier is not installed: run 'bun install --frozen-lockfile' in $ROOT/" >&2
	exit 1
fi
cd "$ROOT/shared"
bun "$PRETTIER" $MODE "**/*.{ts,json}"
