#!/bin/sh
# Every gate, stopping at the first failure. Without `set -e` the status of this script was
# the status of its last line (fix-rights.sh), so a failing suite still reported success.
set -e
cd "$(dirname "$0")"
./test-be.sh
./test-fe.sh
./test-shared.sh
./test-cli.sh
./fix-rights.sh
