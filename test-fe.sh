#!/bin/sh
# Frontend gates.
#
# Through `bun run` rather than the bare binaries: `svelte-check` is not on PATH, it lives in
# frontend/node_modules/.bin, so calling it directly failed with "command not found" - and
# with the exit status swallowed by a pipe, that looked like a pass.
#
# The browser fixtures under frontend/tests/browser are NOT run here: they need a real
# browser, which this repository does not depend on. Serve them with `bun run test:browser`
# in frontend/ and open each page; every fixture sets
# `document.documentElement.dataset.testStatus` to passed or failed and leaves its per-case
# results in `window.<name>TestResults`.
set -e
cd frontend
bun run check
bun run test
cd ..
