#!/bin/sh

echo -ne "\033]0;LISH BACKEND (HOT)\007"
bun i --frozen-lockfile
bun --watch run src/app.ts "$@"
