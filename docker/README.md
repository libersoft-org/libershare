# LiberShare Docker

This compose setup runs LiberShare as two containers:

- `libershare-backend`: Bun-compiled backend, WebSocket API, libp2p node
- `libershare-frontend`: static Svelte frontend served by a small Bun HTTPS server

Run commands from this `docker/` directory.

## Defaults

- Compose project name: `libershare`
- Backend API/WebSocket: `127.0.0.1:${BACKEND_PORT:-1158}` (host-bound to loopback by default)
- libp2p TCP: `9091:9090` (LAN-bound — peers must reach it externally)
- Frontend HTTPS: `127.0.0.1:6003` (host-bound to loopback by default, see `FRONTEND_BIND`)
- Browser URL: `https://localhost:6003/`
- API token: required, `LISH_TOKEN` in `.env`
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

Docker named volumes (`CONFIG_SOURCE=my-libershare-config`) work
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
CONFIG_SOURCE=/mnt/ssd/libershare-config \
STORAGE_SOURCE=/mnt/big/libershare-storage \
docker compose up -d
```

To use Docker named volumes instead of local directories:

```sh
CONFIG_SOURCE=my-libershare-config \
STORAGE_SOURCE=my-libershare-storage \
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

The API token is required: `docker compose up` refuses to start without it.
Create `.env` next to `docker-compose.yml` once:

```sh
echo "LISH_TOKEN=$(openssl rand -hex 32)" > .env
chmod 600 .env
```

Every WebSocket and `/status` request must carry the token as `?token=<value>`.
Only the liveness probe `/health` is public. `/status` without the token
answers `401` with `authRequired: true`, which is how the web UI knows to show
its login form.

Open `https://localhost:6003/`, paste the value of `LISH_TOKEN` into the login
form and clear the clipboard afterwards. After changing the token, restart the
backend (`docker compose up -d backend`) and enter the new value in the same
form — no page reload is needed. The frontend proxy checks the token with the
backend before it opens the WebSocket, forwards the query unchanged and never
logs it.

CLI / curl on the Docker host:

```sh
curl -fsS "http://localhost:${BACKEND_PORT:-1158}/status?token=$LISH_TOKEN"
```

### Access from other machines

The token travels in the URL, so anything beyond loopback must be encrypted:

- UI: set `FRONTEND_BIND=0.0.0.0` only together with a certificate the browser
  trusts (see *TLS*), and open `https://<host>:6003/`.
- API: set `BACKEND_BIND=0.0.0.0` only behind a TLS-terminating reverse proxy
  or another encrypted channel (VPN, SSH tunnel); the backend itself speaks
  plain `ws://`.

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
TLS_CERT_SAN=DNS:localhost,IP:127.0.0.1,IP:192.168.1.10 docker compose up -d
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
MEMTRACE=0
```

Set `MEMTRACE=1` only while collecting diagnostics. Memory trace
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

## WebSocket proxy behaviour

The frontend container terminates the browser WebSocket and forwards it to
`ws://backend:$BACKEND_PORT`. Before the upgrade it asks the backend's
`/status` with the client's query; a wrong token is answered `401` and no
socket is opened. `/status` answers `503` when the backend is unreachable and
`504` when it does not answer within 2.5 s.

Each browser socket gets exactly one upstream connection. If that connection
cannot be opened within 2.5 s, is refused (for example because the backend
restarted with a new token), or drops later, the browser socket is closed with
code 1011. The web UI then checks `/status` again and either reconnects or
shows the login form. Messages sent before the upstream opens are buffered up
to 1 MiB; beyond that the client is closed with 1011 as well.

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
