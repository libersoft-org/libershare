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
	const parts = decoded.split('/').filter((part) => part && part !== '.' && part !== '..');
	return parts.length > 0 ? join(root, ...parts) : join(root, 'index.html');
}

type ClientData = {
	upstream?: WebSocket;
	pending: Array<string | ArrayBuffer | Uint8Array>;
};

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
			const upgraded = server.upgrade<ClientData>(request, { data: { pending: [] } });
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
			const upstream = new WebSocket(backendWsUrl);
			ws.data.upstream = upstream;

			upstream.onopen = () => {
				for (const message of ws.data.pending.splice(0)) upstream.send(message);
			};
			upstream.onmessage = event => {
				if (ws.readyState === WebSocket.OPEN) ws.send(event.data);
			};
			upstream.onclose = () => ws.close();
			upstream.onerror = () => ws.close();
		},
		message(ws, message) {
			const upstream = ws.data.upstream;
			if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
			else ws.data.pending.push(message);
		},
		close(ws) {
			ws.data.upstream?.close();
		},
	},
});

const protocol = tlsEnabled ? 'https' : 'http';
console.log(`LiberShare frontend listening on ${protocol}://0.0.0.0:${port}`);
