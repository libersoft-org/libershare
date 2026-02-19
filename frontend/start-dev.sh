#!/bin/sh

# Usage: ./start-dev.sh [backend_url] [--privkey path] [--pubkey path]
# Backend URL: first positional argument, e.g.: ./start-dev.sh wss://backend.example.com:1234
# Default: ws://localhost:1158
# Certificates: --privkey and --pubkey for HTTPS dev server
# Default: server.key/server.crt or certs/server.key/certs/server.crt

while [ $# -gt 0 ]; do
	case "$1" in
		--privkey) export VITE_SSL_KEY="$2"; shift 2 ;;
		--pubkey)  export VITE_SSL_CERT="$2"; shift 2 ;;
		*)
			if [ -z "$VITE_BACKEND_URL" ]; then
				export VITE_BACKEND_URL="$1"
				echo "Using custom backend: $VITE_BACKEND_URL"
			fi
			shift
			;;
	esac
done

echo -ne "\033]0;LISH FRONTEND\007"
bun i --frozen-lockfile
#bun --bun run dev
npm run dev
