# LiberShare Docker

This compose setup runs LiberShare as two containers:

- `libershare-backend`: Bun-compiled backend, WebSocket API, libp2p node
- `libershare-frontend`: static Svelte frontend served by a small Bun HTTPS server

Run commands from this `docker/` directory.

## Defaults

- Compose project name: `libershare`
- Backend API/WebSocket: `127.0.0.1:${BACKEND_PORT:-1158}` (host-bound to loopback by default)
- libp2p TCP: `9091:9090` (LAN-bound — peers must reach it externally)
- Frontend HTTPS: `6003:6003`
- Browser URL: `https://<docker-host>:6003/`
- Docker network: `libershare-net`, created automatically by compose

The frontend container reaches the backend over the internal Docker network
(`ws://backend:${BACKEND_PORT}`), so the API does not need to be published on
the host's public interface. Override with `BACKEND_BIND=0.0.0.0` only when a
non-Docker frontend or the CLI client running on another machine needs direct
access.

Default writable paths are local directories next to `docker-compose.yml`:

- `./config` -> `/app/config`
- `./storage` -> `/app/storage`
- `./certs` -> `/app/certs`

`./config` contains backend runtime state: `settings.json`, `libershare.db`,
`libershare.log`, and libp2p datastore. `./storage` is used by default for
finished downloads, temp files, LISH files, LISH network files, and backups.
`./certs` contains frontend TLS certificate files.

## First-run permissions

Both services run with `cap_drop: ALL` and `read_only: true` rootfs, but each
keeps `cap_add: CHOWN` so its entrypoint can re-own the bind-mounted state
directories (`/app/config`, `/app/storage`, `/app/certs`) to UID 0 at startup.
The deploy is therefore independent of who runs `mkdir` on the host:

```sh
mkdir -p config storage certs
docker compose up -d --build
```

If the entrypoints are bypassed (e.g. somebody removes `cap_add: CHOWN`) the
backend still fails fast with an actionable message instead of silently
losing writes:

```
[Storage] FATAL: cannot persist /app/config/settings.json (EACCES).
[Storage] Fix on the host: chown 0:0 <mounted-dir> && chmod 0700 <mounted-dir>, then restart.
```

Docker named volumes (`LIBERSHARE_CONFIG_SOURCE=my-libershare-config`) work
out of the box without any host-side `mkdir` — the daemon creates the volume
root-owned.

## Start

```sh
docker compose config
docker compose up -d --build
docker compose logs -f
```

The frontend `depends_on.backend.condition: service_healthy` waits until the
backend healthcheck reports `healthy` before the frontend container is
started, so the WebSocket proxy never races a backend that's still booting.

## Storage

For a fresh config, backend storage settings default to:

- `/app/storage/finished/`
- `/app/storage/temp/`
- `/app/storage/lish/`
- `/app/storage/lishnet/`
- `/app/storage/backup/`

To put config and storage on specific host disks:

```sh
mkdir -p /mnt/ssd/libershare-config /mnt/big/libershare-storage
LIBERSHARE_CONFIG_SOURCE=/mnt/ssd/libershare-config \
LIBERSHARE_STORAGE_SOURCE=/mnt/big/libershare-storage \
docker compose up -d
```

To use Docker named volumes instead of local directories:

```sh
LIBERSHARE_CONFIG_SOURCE=my-libershare-config \
LIBERSHARE_STORAGE_SOURCE=my-libershare-storage \
docker compose up -d
```

When migrating an existing node, keep its old config/datastore/database mounted
as `/app/config`; otherwise the backend generates a new peer identity and starts
as a different node.

## Ports

Set `BACKEND_PORT` to run the backend API/WebSocket on a different port:

```sh
BACKEND_PORT=2158 docker compose up -d
```

The frontend never hardcodes the backend browser port. Browser WebSocket traffic
goes to same-origin `/ws`, and the frontend container proxies it to:

```sh
BACKEND_WS_URL=ws://backend:${BACKEND_PORT:-1158}
```

By default the host-side publication of the backend API/WebSocket port is
bound to `127.0.0.1`, so only the local machine (and the in-network frontend
container) can reach it. Set `BACKEND_BIND=0.0.0.0` to expose the API to the
LAN — for example when the CLI client or a non-Docker frontend runs on a
different host:

```sh
BACKEND_BIND=0.0.0.0 docker compose up -d
```

Combine `BACKEND_BIND=0.0.0.0` with `LISH_TOKEN=...` (see *Authentication*
below) so the exposed port still requires a shared secret.

## Authentication

The backend reads `LISH_TOKEN` from the environment. Set it in `.env` next
to `docker-compose.yml`:

```sh
LISH_TOKEN=$(openssl rand -hex 32)
```

When `LISH_TOKEN` is non-empty, every WebSocket and REST request must carry
the same value as `?token=<value>` in the URL — the only exceptions are the
liveness probe `/health` and the auth-state endpoint `/status`, which stay
public so orchestrators and the frontend can detect the auth state without
already knowing the token.

Browser side: the SvelteKit frontend stores the token (set on the auth
prompt or injected as `__BACKEND_TOKEN__` by the Tauri shell) and passes it
on every WebSocket reconnect. The Docker frontend proxy forwards URLs as-is,
so the same `?token=` query string is preserved when the browser connects to
same-origin `/ws`.

CLI / curl:

```sh
curl -fsS "http://localhost:${BACKEND_PORT:-1158}/status?token=$LISH_TOKEN"
```

Leave `LISH_TOKEN` unset (the default) to disable authentication entirely.

## TLS

The frontend serves HTTPS. On first start it generates a self-signed certificate
in `./certs` unless `TLS_CERT_FILE` and `TLS_KEY_FILE` point to existing files.

Default self-signed SAN:

```sh
DNS:localhost,IP:127.0.0.1
```

Set `TLS_CERT_SAN` before the first frontend start when the self-signed
certificate must be valid for a LAN IP or DNS name:

```sh
TLS_CERT_SAN=DNS:localhost,IP:127.0.0.1,IP:192.168.2.9 docker compose up -d
```

To use a real certificate for a hostname, mount a cert directory and point the
container paths at the cert/key:

```sh
TLS_CERT_SOURCE=/etc/libershare/certs \
TLS_CERT_FILE=/app/certs/fullchain.pem \
TLS_KEY_FILE=/app/certs/privkey.pem \
docker compose up -d
```

The browser hostname must match the certificate SAN, for example
`https://lish.example.net:6003/`. For Let's Encrypt live directories, mount or
copy real files; symlinks under `/etc/letsencrypt/live/...` also need their
`archive` target available inside the container.

## Logs

Backend application logs are written to:

```sh
./config/libershare.log
```

The app rotates `libershare.log` at 10 MB and keeps 3 rotated files.

Docker stdout/stderr logs are rotated by compose:

```sh
LOG_MAX_SIZE=10m
LOG_MAX_FILE=3
```

Backend memory tracing is disabled by default:

```sh
LIBERSHARE_MEMTRACE=0
```

Set `LIBERSHARE_MEMTRACE=1` only while collecting diagnostics. Memory trace
output is an application file, not a Docker log, so Docker log rotation does not
rotate `memory-trace.jsonl`.

## Hardening

Both services run with:

- `no-new-privileges`
- all Linux capabilities dropped
- read-only root filesystem
- writable state only through explicit mounts and `/tmp`

## Healthcheck

The backend exposes an unauthenticated `GET /health` endpoint that returns
`200 ok` once the API server has bound. The compose healthcheck reuses the
same binary as a self-probe:

```yaml
healthcheck:
  test: ["CMD", "/app/lish-backend", "--healthcheck"]
  interval: 10s
  timeout: 3s
  retries: 5
  start_period: 20s
```

`--healthcheck` does no logger setup, no DB open, no libp2p init — it just
performs one HTTP `GET http://127.0.0.1:$BACKEND_PORT/health` and exits 0 on
2xx, 1 on any other response, 2 on a misconfigured `BACKEND_PORT` env. Probe
the endpoint manually with:

```sh
curl -fsS http://localhost:${BACKEND_PORT:-1158}/health
```

## WebSocket proxy resilience

The frontend container terminates the browser WebSocket and forwards it to
`ws://backend:$BACKEND_PORT`. If the backend goes away (rolling restart,
crash) the proxy keeps the browser-side socket alive while it reconnects the
upstream with exponential backoff (250 ms → 5 s, capped). It buffers up to
1 MiB of in-flight messages during the outage; if that ceiling is exceeded
the client is closed with code 1011 to force a fresh handshake instead of
silently dropping subscribe messages.

A single warning is logged after 10 consecutive reconnect attempts; further
retries continue silently to avoid filling the proxy log when a tab is left
open across a long backend outage.

## Verification

Run project checks inside Docker/Bun instead of relying on host Node/Bun:

```sh
docker run --rm -v "$PWD/..:/src" -w /src/frontend oven/bun:1.3.13-debian \
  sh -lc "bun install --frozen-lockfile && bun test tests/api-url.test.ts && bun --bun run check && bun --bun run build"
```

Build both images:

```sh
docker compose build backend frontend
```
