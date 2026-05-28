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
COPY docker/frontend-server.ts ./frontend-server.ts
COPY docker/frontend-entrypoint.sh ./frontend-entrypoint.sh
RUN chmod 0755 ./frontend-entrypoint.sh

EXPOSE 6003/tcp
ENTRYPOINT ["./frontend-entrypoint.sh"]
