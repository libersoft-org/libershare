#!/bin/sh
set -eu

# Repair ownership of bind-mounted state directories before dropping into the
# backend binary. With `cap_drop: ALL` the container loses CAP_DAC_OVERRIDE,
# so a host-side `mkdir ./config ./storage` performed by an unprivileged
# user (UID != 0) would otherwise produce EACCES on the first write inside
# the container. CAP_CHOWN is granted back via `cap_add` in compose so the
# chown succeeds without re-introducing CAP_DAC_OVERRIDE.
#
# Already-correct ownership is a no-op for chown — there is no I/O cost
# beyond a stat() per entry, and -R only descends if directories exist.
for dir in /app/config /app/storage; do
	if [ -d "$dir" ]; then
		chown -R 0:0 "$dir" 2>/dev/null || true
	fi
done

exec /app/lish-backend "$@"
