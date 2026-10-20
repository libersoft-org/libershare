# syntax=docker/dockerfile:1

FROM oven/bun:1.3.13-debian AS build

WORKDIR /src

COPY backend/package.json backend/bun.lock ./backend/
# patchedDependencies in package.json are applied by the install below, so the patch files
# must be in place before it runs — copying them with the rest of the sources is too late.
COPY backend/patches ./backend/patches
COPY shared/package.json ./shared/

WORKDIR /src/backend
RUN bun install --frozen-lockfile

# Go and git build the protected-lishnet helper (overlay/); go.mod pins the toolchain it then uses
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git \
	&& rm -rf /var/lib/apt/lists/*
RUN ARCH=$(dpkg --print-architecture) \
	&& curl -fsSL "https://go.dev/dl/go1.26.0.linux-${ARCH}.tar.gz" -o /tmp/go.tar.gz \
	&& tar -C /usr/local -xzf /tmp/go.tar.gz \
	&& rm /tmp/go.tar.gz
ENV PATH="/usr/local/go/bin:${PATH}"

WORKDIR /src
COPY backend ./backend
COPY shared ./shared
COPY overlay ./overlay

ARG TARGETARCH
RUN set -eu; \
	case "$TARGETARCH" in \
		amd64) BUN_TARGET="bun-linux-x64" ;; \
		arm64) BUN_TARGET="bun-linux-arm64" ;; \
		*) echo "Unsupported Docker target architecture: $TARGETARCH" >&2; exit 1 ;; \
	esac; \
	cd backend; \
	bun build --compile --target "$BUN_TARGET" src/app.ts src/native/worker-runtime.ts src/system-network-corewlan-worker.js \
		--define 'LISH_NATIVE_WORKER_ENTRY="./native/worker-runtime.ts"' \
		--define 'LISH_COREWLAN_WORKER_ENTRY="./system-network-corewlan-worker.js"' \
		--outfile build/lish-backend; \
	bun ../overlay/build.ts --out build/lish-overlay "linux/$TARGETARCH"

FROM debian:trixie-slim AS runtime

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# An unprivileged account; compose may run the service under another UID/GID to match the
# owner of the mounted directories. Only the image's own empty mount points are owned here —
# mounted host data is never re-owned at runtime.
RUN groupadd --gid 1000 lish \
	&& useradd --uid 1000 --gid 1000 --create-home --home-dir /home/lish --shell /usr/sbin/nologin lish \
	&& mkdir -p /app/data /app/config /app/storage \
	&& chown 1000:1000 /app/data /app/config /app/storage \
	&& chmod 0700 /app/data /app/config /app/storage

WORKDIR /app
COPY --from=build /src/backend/build/lish-backend /app/lish-backend
# Next to the backend executable, where it looks for the helper of protected lishnets
COPY --from=build /src/backend/build/lish-overlay /app/lish-overlay
COPY docker/backend-entrypoint.sh /app/backend-entrypoint.sh
RUN chmod 0755 /app/lish-backend /app/lish-overlay /app/backend-entrypoint.sh

USER 1000:1000

EXPOSE 1158/tcp 9090/tcp
ENTRYPOINT ["/app/backend-entrypoint.sh"]
CMD ["--datadir", "/app/data", "--host", "0.0.0.0", "--port", "1158"]
