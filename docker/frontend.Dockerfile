# syntax=docker/dockerfile:1

FROM oven/bun:1.3.13-debian AS build

WORKDIR /src

COPY frontend/package.json frontend/bun.lock ./frontend/
COPY shared/package.json ./shared/

WORKDIR /src/frontend
RUN bun install --frozen-lockfile

WORKDIR /src
COPY frontend ./frontend
COPY shared ./shared

WORKDIR /src/frontend
RUN bun --bun run build

FROM oven/bun:1.3.13-alpine AS runtime

RUN apk add --no-cache openssl

WORKDIR /app
COPY --from=build /src/frontend/build ./build
COPY shared/src/product.json ./product.json
COPY shared/src/product.ts ./product.ts
COPY docker/frontend-server.ts ./frontend-server.ts
COPY docker/frontend-entrypoint.sh ./frontend-entrypoint.sh
# The certificate directory is the only place the service writes; the base image's `bun`
# account is UID 1000.
RUN chmod 0755 ./frontend-entrypoint.sh \
	&& mkdir -p /app/certs \
	&& chown 1000:1000 /app/certs \
	&& chmod 0700 /app/certs

USER 1000:1000

EXPOSE 6003/tcp
ENTRYPOINT ["./frontend-entrypoint.sh"]
