#!/bin/sh
# Launch {{product_name}} in debug mode (opens a backend debug console window)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/{{exec_name}}" --debug "$@"
