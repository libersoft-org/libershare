#!/bin/sh
set -eu

# Mounted directories keep the owner the host gave them: run the service as that UID/GID
# (LISH_UID/LISH_GID in compose) instead of changing ownership here.
if [ "$(id -u)" = 0 ]; then
	echo "Refusing to run as root. Set LISH_UID/LISH_GID to the owner of the mounted directories." >&2
	exit 1
fi
umask 077

exec /app/lish-backend "$@"
