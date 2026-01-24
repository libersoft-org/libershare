#!/bin/sh

# Backend URL can be passed as first argument, e.g.: ./start-dev.sh ws://backend.example.com:1234
# Default: ws://localhost:1158
if [ -n "$1" ]; then
 export VITE_BACKEND_URL="$1"
 echo "Using custom backend: $VITE_BACKEND_URL"
fi

echo -ne "\033]0;LISH FRONTEND\007"
bun i --frozen-lockfile
#bun --bun run dev
npm run dev
