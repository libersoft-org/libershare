import { join } from 'node:path';

const root = '/app/build';
const port = Number(process.env['PORT'] ?? 6003);
const backendWsUrl = process.env['BACKEND_WS_URL'];
const keyFile = process.env['TLS_KEY_FILE'];
const certFile = process.env['TLS_CERT_FILE'];
const tlsEnabled = Boolean(keyFile && certFile);

if (!backendWsUrl) throw new Error('BACKEND_WS_URL is required');

const contentTypes: Record<string, string> = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.ico': 'image/x-icon',
	'.js': 'application/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.txt': 'text/plain; charset=utf-8',
	'.webp': 'image/webp',
};

function contentType(path: string): string | undefined {
	const dot = path.lastIndexOf('.');
	return dot >= 0 ? contentTypes[path.slice(dot).toLowerCase()] : undefined;
}

function fileForPath(pathname: string): string {
	const decoded = decodeURIComponent(pathname);
	const parts = decoded.split('/').filter(part => part && part !== '.' && part !== '..');
	return parts.length > 0 ? join(root, ...parts) : join(root, 'index.html');
}

type ClientData = {
	upstream?: WebSocket;
	pending: Array<string | ArrayBuffer | Uint8Array>;
	closed: boolean;
	reconnectAttempt: number;
	reconnectTimer?: ReturnType<typeof setTimeout>;
	/**
	 * Upstream URL with the client's original query string preserved so the
	 * backend sees `?token=…` (and any future query params) when
	 * authentication is enabled. Computed at upgrade time and reused on
	 * every reconnect attempt.
	 */
	upstreamUrl: string;
};

/**
 * Build the upstream WebSocket URL for one client connection by copying any
 * query params from the incoming `/ws` URL onto the configured
 * `BACKEND_WS_URL`. The backend's `isAuthorized` middleware reads `?token=…`
 * from the URL it receives, so without this the token a client carries on
 * `wss://frontend/ws?token=…` would be lost at the proxy boundary.
 */
function buildUpstreamUrl(clientUrl: URL): string {
	const upstream = new URL(backendWsUrl!);
	for (const [k, v] of clientUrl.searchParams) upstream.searchParams.set(k, v);
	return upstream.toString();
}

const MAX_PENDING_BYTES = 1 * 1024 * 1024; // 1 MiB cap so a long backend outage does not exhaust container memory
const MAX_RECONNECT_DELAY_MS = 5000;
const BASE_RECONNECT_DELAY_MS = 250;
// Log a single warning after this many consecutive upstream-reconnect attempts
// fail; reconnects continue silently afterwards so a tab left open over a
// weekend doesn't fill the proxy log with retries.
const RECONNECT_WARN_AFTER_ATTEMPTS = 10;

function pendingByteSize(pending: ClientData['pending']): number {
	let total = 0;
	for (const m of pending) total += typeof m === 'string' ? Buffer.byteLength(m, 'utf8') : m.byteLength;
	return total;
}

function connectUpstream(ws: import('bun').ServerWebSocket<ClientData>): void {
	if (ws.data.closed) return;
	const upstream = new WebSocket(ws.data.upstreamUrl);
	ws.data.upstream = upstream;
	upstream.onopen = () => {
		ws.data.reconnectAttempt = 0;
		for (const message of ws.data.pending.splice(0)) upstream.send(message);
	};
	upstream.onmessage = event => {
		if (ws.readyState === WebSocket.OPEN) ws.send(event.data);
	};
	const handleDrop = (): void => {
		if (ws.data.closed) return;
		// Exponential backoff capped at MAX_RECONNECT_DELAY_MS. The browser
		// tab stays connected to this proxy while we retry the upstream — so
		// a backend rolling restart no longer forces every open page to
		// reload to recover its WebSocket session.
		const attempt = ws.data.reconnectAttempt++;
		if (attempt === RECONNECT_WARN_AFTER_ATTEMPTS) {
			console.warn(`[proxy] upstream still unreachable after ${attempt} attempts; will keep retrying every ${MAX_RECONNECT_DELAY_MS}ms`);
		}
		const delay = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** attempt);
		ws.data.reconnectTimer = setTimeout(() => connectUpstream(ws), delay);
	};
	upstream.onclose = handleDrop;
	upstream.onerror = handleDrop;
}

Bun.serve({
	port,
	tls: tlsEnabled
		? {
				key: Bun.file(keyFile!),
				cert: Bun.file(certFile!),
			}
		: undefined,
	async fetch(request, server) {
		const url = new URL(request.url);
		if (url.pathname === '/ws') {
			const upgraded = server.upgrade<ClientData>(request, {
				data: { pending: [], closed: false, reconnectAttempt: 0, upstreamUrl: buildUpstreamUrl(url) },
			});
			if (upgraded) return undefined;
			return new Response('Expected WebSocket', { status: 400 });
		}

		const filePath = fileForPath(url.pathname);
		let file = Bun.file(filePath);

		if (!(await file.exists())) {
			file = Bun.file(join(root, 'index.html'));
		}

		return new Response(file, {
			headers: contentType(file.name ?? filePath) ? { 'content-type': contentType(file.name ?? filePath)! } : undefined,
		});
	},
	websocket: {
		open(ws) {
			connectUpstream(ws);
		},
		message(ws, message) {
			const upstream = ws.data.upstream;
			if (upstream?.readyState === WebSocket.OPEN) {
				upstream.send(message);
				return;
			}
			// Buffer messages while upstream is reconnecting. The LISH protocol
			// is stateful (subscribe → receive events) — silently dropping the
			// oldest queued message would let the subscribe handshake disappear
			// while later events survive, leaving the FE wired to a topic the
			// backend never registered. Closing the client with a non-normal
			// code instead forces the browser-side WsClient to reconnect and
			// re-run its full handshake from scratch.
			ws.data.pending.push(message);
			if (pendingByteSize(ws.data.pending) > MAX_PENDING_BYTES) {
				console.warn(`[proxy] pending queue exceeded ${MAX_PENDING_BYTES} bytes during upstream outage; closing client to force re-handshake`);
				ws.data.pending.length = 0;
				ws.close(1011, 'upstream backlog overflow');
			}
		},
		close(ws) {
			ws.data.closed = true;
			if (ws.data.reconnectTimer) {
				clearTimeout(ws.data.reconnectTimer);
				ws.data.reconnectTimer = undefined;
			}
			ws.data.upstream?.close();
		},
	},
});

const protocol = tlsEnabled ? 'https' : 'http';
console.log(`LiberShare frontend listening on ${protocol}://0.0.0.0:${port}`);
