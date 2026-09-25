#!/bin/sh
# Backend gates. `set -e` and no trailing `cd ..`: the old last line was a `cd` that always
# succeeded, so the script reported success whatever the typecheck said.
set -e
cd "$(dirname "$0")/backend"
bun run typecheck
bun run test
bun run test:e2e
