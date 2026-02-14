#!/bin/sh

bun i --frozen-lockfile
bun build --compile src/app.ts --outfile build/lish-backend
