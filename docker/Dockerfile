# syntax=docker/dockerfile:1

FROM oven/bun:1.3.13-debian AS build

WORKDIR /src

COPY backend/package.json backend/bun.lock ./backend/
COPY shared/package.json ./shared/

WORKDIR /src/backend
RUN bun install --frozen-lockfile

WORKDIR /src
COPY backend ./backend
COPY shared ./shared

ARG TARGETARCH
# Two-step build: the backend binary and the checksum worker must be separate
# artifacts. At runtime app.ts resolves the worker via
# pathToFileURL(dirname(execPath) + '/lish/checksum-worker.js') — a single
# `bun build --compile` with multiple entrypoints would not produce that sidecar
# file structure and LISH creation would hang trying to spawn the worker.
RUN set -eu; \
	case "$TARGETARCH" in \
		amd64) BUN_TARGET="bun-linux-x64" ;; \
		arm64) BUN_TARGET="bun-linux-arm64" ;; \
		*) echo "Unsupported Docker target architecture: $TARGETARCH" >&2; exit 1 ;; \
	esac; \
	cd backend; \
	bun build --compile --target "$BUN_TARGET" ./src/app.ts --outfile build/lish-backend; \
	mkdir -p build/lish; \
	bun build ./src/lish/checksum-worker.ts --target bun --outfile build/lish/checksum-worker.js

FROM debian:trixie-slim AS runtime

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /src/backend/build/lish-backend /app/lish-backend
COPY --from=build /src/backend/build/lish /app/lish
RUN chmod 0755 /app/lish-backend

EXPOSE 1158/tcp 9090/tcp
ENTRYPOINT ["/app/lish-backend"]
CMD ["--datadir", "/app/data", "--host", "0.0.0.0", "--port", "1158"]
