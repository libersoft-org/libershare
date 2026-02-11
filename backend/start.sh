#!/bin/sh

echo -ne "\033]0;LISH BACKEND\007"
bun i --frozen-lockfile
bun run src/app.ts "$@"
