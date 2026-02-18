#!/bin/sh
# Launch {{product_name}} in debug mode (opens a backend debug console window)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
case "$(uname -s)" in
	Darwin) open "$SCRIPT_DIR/{{product_name}}.app" --args --debug ;;
	*)      exec "$SCRIPT_DIR/{{exec_name}}" --debug "$@" ;;
esac
