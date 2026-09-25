#!/bin/sh
# Every package, stopping at the first failure; the mode (default --write, or --check) is
# passed to each of them.
set -e
cd "$(dirname "$0")"
./prettier-be.sh "$@"
./prettier-shared.sh "$@"
./prettier-fe.sh "$@"
./prettier-cli.sh "$@"
