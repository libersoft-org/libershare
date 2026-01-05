#!/bin/sh

cd node_modules/@chainsafe/libp2p-gossipsub
bun i --frozen-lockfile
bun run --bun build
