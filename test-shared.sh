#!/bin/sh
set -e
cd "$(dirname "$0")/shared"
bun run typecheck
