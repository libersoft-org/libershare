#!/bin/sh
# Fix: @chainsafe/libp2p-gossipsub OutboundStream.push is incorrectly declared async.
# The synchronous throw from rawStream.send() becomes a rejected Promise,
# escaping try/catch in sendRpc() → unhandledRejection flood (StreamStateError
# "Cannot write to a stream that is closed", 200-600/h per node).
#
# Remove the async keyword so the throw stays synchronous and IS caught by
# the existing try/catch in sendRpc() (gossipsub.js:1860).
#
# Upstream: https://github.com/ChainSafe/js-libp2p-gossipsub — file issue/PR
# Applied: 2026-04-19 via backend postinstall
set -e
TARGET="node_modules/@chainsafe/libp2p-gossipsub/dist/src/stream.js"
if [ ! -f "$TARGET" ]; then
	echo "[patch] $TARGET not found (skip)"
	exit 0
fi
if grep -q "^    push(data) {" "$TARGET"; then
	echo "[patch] gossipsub async-push fix already applied"
	exit 0
fi
if grep -q "^    async push(data) {" "$TARGET"; then
	perl -pi -e 's/^    async push\(data\) \{/    push(data) {/' "$TARGET"
	echo "[patch] gossipsub async-push fix applied to $TARGET"
else
	echo "[patch] unexpected content in $TARGET — skip"
	exit 0
fi
