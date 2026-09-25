import { join } from 'node:path';
import { productName, MAX_API_MESSAGE_SIZE } from './product.ts';

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
	/** Fires when the single upstream dial has not opened in time. */
	openTimer?: ReturnType<typeof setTimeout>;
	/**
	 * Upstream URL carrying the client's original query string, so the backend sees the same
	 * `?token=…` the proxy authorised. Computed at upgrade time.
	 */
	upstreamUrl: string;
};

/** Ceiling for a status request to the backend and for the upstream WebSocket to open. */
const UPSTREAM_TIMEOUT_MS = 2500;
/** A status reply is a few fields; anything larger is not a status reply. */
const MAX_STATUS_BODY_BYTES = 4096;
const MAX_PENDING_BYTES = 1 * 1024 * 1024; // 1 MiB cap so a slow upstream open does not exhaust container memory
const NO_STORE = { 'cache-control': 'no-store' };

/**
 * Put the client's raw query string on a backend URL unchanged — duplicated parameters
 * included — so the backend, not the proxy, decides whether it is acceptable.
 */
function withClientQuery(target: URL, clientUrl: URL): URL {
	target.search = clientUrl.search;
	return target;
}

function buildUpstreamUrl(clientUrl: URL): string {
	return withClientQuery(new URL(backendWsUrl!), clientUrl).toString();
}

/** The backend's `/status` URL: the http(s) counterpart of BACKEND_WS_URL. */
function statusUrl(clientUrl: URL): URL {
	const target = new URL(backendWsUrl!);
	target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
	target.pathname = '/status';
	target.hash = '';
	return withClientQuery(target, clientUrl);
}

function pendingByteSize(pending: ClientData['pending']): number {
	let total = 0;
	for (const m of pending) total += typeof m === 'string' ? Buffer.byteLength(m, 'utf8') : m.byteLength;
	return total;
}

/** 503 when the backend cannot be reached, 504 when it did not answer in time. */
function unavailableStatus(error: unknown): 503 | 504 {
	return (error as Error)?.name === 'TimeoutError' ? 504 : 503;
}

function upstreamSignal(request: Request): AbortSignal {
	return AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
}

type StatusOutcome = { kind: 'answer'; status: 200 | 401; body: string } | { kind: 'unavailable'; status: 502 | 503 | 504 };

/**
 * Ask the backend's `/status` whether the client's query authorises it. Only a 200 or 401 with
 * a consistent JSON body counts as an answer; a redirect, another status or a malformed or
 * oversized body is 502. The query carries the token, so it is never logged.
 */
async function checkStatus(request: Request, clientUrl: URL): Promise<StatusOutcome> {
	let response: Response;
	try {
		response = await fetch(statusUrl(clientUrl), { redirect: 'manual', signal: upstreamSignal(request) });
	} catch (error) {
		return { kind: 'unavailable', status: unavailableStatus(error) };
	}
	if (response.status !== 200 && response.status !== 401) {
		await response.body?.cancel().catch(() => {});
		return { kind: 'unavailable', status: 502 };
	}
	let body: string;
	try {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > MAX_STATUS_BODY_BYTES) return { kind: 'unavailable', status: 502 };
		body = new TextDecoder().decode(bytes);
	} catch (error) {
		return { kind: 'unavailable', status: unavailableStatus(error) };
	}
	let parsed: { ok?: unknown; authRequired?: unknown; authenticated?: unknown };
	try {
		parsed = JSON.parse(body);
	} catch {
		return { kind: 'unavailable', status: 502 };
	}
	const authenticated = parsed?.ok === true && parsed.authenticated === true;
	if (typeof parsed?.authRequired !== 'boolean' || authenticated !== (response.status === 200)) return { kind: 'unavailable', status: 502 };
	return { kind: 'answer', status: response.status, body };
}

function statusReply(outcome: StatusOutcome): Response {
	const headers = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...NO_STORE };
	if (outcome.kind === 'unavailable') return new Response(JSON.stringify({ ok: false, error: 'BACKEND_UNAVAILABLE' }), { status: outcome.status, headers });
	return new Response(outcome.body, { status: outcome.status, headers });
}

/** Forward a CORS preflight. Only a 204 from the backend is passed on, with its CORS headers alone. */
async function forwardPreflight(request: Request, clientUrl: URL): Promise<Response> {
	const headers = new Headers();
	for (const name of ['origin', 'access-control-request-method', 'access-control-request-headers']) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	let response: Response;
	try {
		response = await fetch(statusUrl(clientUrl), { method: 'OPTIONS', headers, redirect: 'manual', signal: upstreamSignal(request) });
	} catch (error) {
		return new Response(null, { status: unavailableStatus(error), headers: NO_STORE });
	}
	await response.body?.cancel().catch(() => {});
	if (response.status !== 204) return new Response(null, { status: 502, headers: NO_STORE });
	const reply = new Headers(NO_STORE);
	for (const [name, value] of response.headers) if (name.toLowerCase().startsWith('access-control-')) reply.set(name, value);
	return new Response(null, { status: 204, headers: reply });
}

/**
 * Dial the backend once for this client. Any failure — a refused handshake, a network error, a
 * close before or after opening, or no open within the timeout — closes the client with 1011.
 * The backend drops everything keyed to a socket when it goes, so a silent reconnect would hand
 * the browser a session without its subscriptions; closing makes the browser re-run its status
 * check and handshake instead.
 */
function connectUpstream(ws: import('bun').ServerWebSocket<ClientData>): void {
	if (ws.data.closed) return;
	const upstream = new WebSocket(ws.data.upstreamUrl);
	ws.data.upstream = upstream;
	let failed = false;
	const fail = (reason: string): void => {
		if (failed) return;
		failed = true;
		clearTimeout(ws.data.openTimer);
		ws.data.pending.length = 0;
		upstream.close();
		if (!ws.data.closed) ws.close(1011, reason);
	};
	ws.data.openTimer = setTimeout(() => fail('upstream handshake timeout'), UPSTREAM_TIMEOUT_MS);
	upstream.onopen = () => {
		clearTimeout(ws.data.openTimer);
		if (failed || ws.data.closed) {
			upstream.close();
			return;
		}
		for (const message of ws.data.pending.splice(0)) upstream.send(message);
	};
	upstream.onmessage = event => {
		if (!failed && ws.readyState === WebSocket.OPEN) ws.send(event.data);
	};
	upstream.onclose = () => fail('upstream session lost');
	upstream.onerror = () => fail('upstream session lost');
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
		if (url.pathname === '/status') {
			if (request.method === 'GET') return statusReply(await checkStatus(request, url));
			if (request.method === 'OPTIONS') return forwardPreflight(request, url);
			return new Response(null, { status: 405, headers: { allow: 'GET, OPTIONS', ...NO_STORE } });
		}
		if (url.pathname === '/ws') {
			// Authorised before the upgrade: a wrong token is a 401 the browser can read, not a
			// socket that opens and then dies.
			const outcome = await checkStatus(request, url);
			if (outcome.kind !== 'answer' || outcome.status !== 200) return statusReply(outcome);
			const upgraded = server.upgrade<ClientData>(request, {
				data: { pending: [], closed: false, upstreamUrl: buildUpstreamUrl(url) },
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
		// Match the backend's limit — otherwise this proxy is the one that quietly
		// drops the connection on a large frame, before the backend ever sees it.
		maxPayloadLength: MAX_API_MESSAGE_SIZE,
		open(ws) {
			connectUpstream(ws);
		},
		message(ws, message) {
			const upstream = ws.data.upstream;
			if (upstream?.readyState === WebSocket.OPEN) {
				upstream.send(message);
				return;
			}
			// Buffer messages until the upstream opens. The LISH protocol is stateful
			// (subscribe → receive events): dropping the oldest queued message could lose the
			// subscribe while later calls survive, so an overflow closes the client instead and
			// the browser re-runs its full handshake.
			ws.data.pending.push(message);
			if (pendingByteSize(ws.data.pending) > MAX_PENDING_BYTES) {
				console.warn(`[proxy] pending queue exceeded ${MAX_PENDING_BYTES} bytes before upstream opened; closing client to force re-handshake`);
				ws.data.pending.length = 0;
				ws.close(1011, 'upstream backlog overflow');
			}
		},
		close(ws) {
			ws.data.closed = true;
			clearTimeout(ws.data.openTimer);
			ws.data.pending.length = 0;
			ws.data.upstream?.close();
		},
	},
});

const protocol = tlsEnabled ? 'https' : 'http';
console.log(`${productName} frontend listening on ${protocol}://0.0.0.0:${port}`);
