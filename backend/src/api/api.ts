import { type ServerWebSocket } from 'bun';
import { mkdir, readdir, stat, unlink } from 'fs/promises';
import { rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { type DataServer } from '../lish/data-server.ts';
import { type Networks } from '../lishnet/lishnets.ts';
import type { PeerCountEntry } from '../protocol/network.ts';
import { type Settings } from '../settings.ts';
import { CodedError, ErrorCodes, MAX_API_MESSAGE_SIZE, formatBytes, sanitizeFilename } from '@shared';
import { unsubscribeAllPeers } from '../protocol/peer-tracker.ts';
import { initSettingsHandlers } from './settings.ts';
import { initLISHnetsHandlers } from './lishnets.ts';
import { initIdentityHandlers } from './identity.ts';
import { initDatasetsHandlers } from './datasets.ts';
import { initFsHandlers } from './fs.ts';
import { initUploadHandlers } from './upload.ts';
import { initLISHsHandlers } from './lishs.ts';
import { initTransferHandlers } from './transfer.ts';
import { initEventsHandlers } from './events.ts';
import { initSystemHandlers } from './system.ts';
import { initRelayHandlers } from './relay.ts';
import { initSearchManager } from './search.ts';
import { buildFactoryResetHandler } from './factory-reset-orchestrator.ts';
import { getLocalAddresses } from '../container.ts';
interface ClientData {
	subscribedEvents: Set<string>;
	isLocalClient: boolean;
}
type ClientSocket = ServerWebSocket<ClientData>;
interface Request {
	id: string;
	method: string;
	params?: Record<string, any>;
}
export interface APIServerOptions {
	host: string;
	port: number;
	secure: boolean;
	keyFile: string | undefined;
	certFile: string | undefined;
	apiToken?: string | undefined;
}

/**
 * Liveness probe handler used by the docker-compose healthcheck and external
 * orchestrators. Returns a 200 plain-text response when the URL pathname is
 * exactly `/health`, or `null` to let the caller fall through to other
 * routing (WebSocket upgrade, 400 fallback). Pure so it stays unit-testable
 * without spinning up the full APIServer dependency graph.
 */
export function handleHealthProbe(req: globalThis.Request): Response | null {
	const url = new URL(req.url);
	if (url.pathname === '/health') return new Response('ok\n', { status: 200, headers: { 'content-type': 'text/plain' } });
	return null;
}

/** Longest original file name kept in a temp upload name, so a pathological name cannot blow the OS limit. */
const MAX_UPLOAD_NAME_LENGTH = 100;

/** How long an uploaded file that was never imported is kept before it is swept. */
const UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Temp file name for an uploaded import file. The random prefix keeps concurrent
 * uploads apart; the original name is appended verbatim because
 * `detectCompression()` reads the trailing extension — losing it would make a
 * brotli upload get read as UTF-8 and fail later as a JSON parse error.
 */
export function uploadFileName(originalName: string): string {
	const safe = sanitizeFilename(originalName).slice(-MAX_UPLOAD_NAME_LENGTH) || 'upload';
	return `${randomUUID()}-${safe}`;
}

/** Longest params blob written to the log; enough to identify a call, short of dumping a file upload. */
const MAX_LOGGED_PARAMS = 1000;

/**
 * Serialise request params for the log, truncated. Some methods carry a whole
 * file chunk, and a multi-megabyte log line per call is both unreadable and a
 * measurable write cost — the truncation alone would not help, because the
 * megabytes are spent building the string before it is cut. A binary payload is
 * always a plain `Uint8Array` (see {@link decodeBinaryRequest}), never a
 * `Buffer`, whose `toJSON` would run before this replacer ever sees it.
 */
export function formatParamsForLog(params: unknown): string {
	const json = JSON.stringify(params, (_key, value) => (value instanceof Uint8Array ? `<${value.byteLength} bytes>` : value)) ?? String(params);
	return json.length <= MAX_LOGGED_PARAMS ? json : json.slice(0, MAX_LOGGED_PARAMS) + `…(${json.length} chars)`;
}

/** Byte length of the header-length prefix on a binary request frame. */
const BINARY_HEADER_PREFIX = 4;

/**
 * Decode a binary request frame, laid out as
 * `[uint32 BE header length][header JSON][payload]`. The header is the same
 * `{ id, method, params }` object a text request carries, so the frame is
 * dispatched and answered by exactly the same code path; the trailing bytes
 * arrive at the handler as `params.data`. Sending a payload this way costs its
 * own size, where base64 in JSON would cost a third more plus an encode and a
 * decode pass over the whole file.
 *
 * The payload is copied out of the frame rather than referenced into it: the
 * message handler is async, so the socket callback returns to Bun before a
 * handler has finished with the bytes, and nothing promises the received buffer
 * stays untouched that long.
 */
export function decodeBinaryRequest(frame: Uint8Array): Request {
	if (frame.byteLength < BINARY_HEADER_PREFIX) throw new CodedError(ErrorCodes.PARSE_ERROR);
	const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0);
	const payloadStart = BINARY_HEADER_PREFIX + headerLength;
	if (payloadStart > frame.byteLength) throw new CodedError(ErrorCodes.PARSE_ERROR);
	const req = JSON.parse(new TextDecoder().decode(frame.subarray(BINARY_HEADER_PREFIX, payloadStart))) as Request;
	req.params = { ...req.params, data: new Uint8Array(frame.subarray(payloadStart)) };
	return req;
}

export class APIServer {
	private clients: Set<ClientSocket> = new Set();
	private server: ReturnType<typeof Bun.serve<ClientData>> | null = null;
	private readonly settings: Settings;
	private readonly host: string;
	private readonly port: number;
	private readonly localAddresses: Set<string>;
	private readonly secure: boolean;
	private readonly keyFile?: string | undefined;
	private readonly certFile?: string | undefined;
	private readonly apiToken?: string | undefined;
	private readonly dataDir: string;
	private readonly uploadDir: string;
	private readonly dataServer: DataServer;
	private readonly networks: Networks;
	private readonly _upload: ReturnType<typeof initUploadHandlers>;
	private _search: ReturnType<typeof import('./search.ts').initSearchManager> | null = null;
	private _system: ReturnType<typeof import('./system.ts').initSystemHandlers> | null = null;

	constructor(dataDir: string, dataServer: DataServer, networks: Networks, settings: Settings, options: APIServerOptions) {
		this.dataDir = dataDir;
		this.uploadDir = join(dataDir, 'tmp');
		this.dataServer = dataServer;
		this.networks = networks;
		this.settings = settings;
		this.host = options.host;
		this.port = options.port;
		this.secure = options.secure;
		this.keyFile = options.keyFile;
		this.certFile = options.certFile;
		this.apiToken = options.apiToken || undefined;
		this.localAddresses = getLocalAddresses();
		const emitTo = (client: ClientSocket, event: string, data: any): void => this.emit(client, event, data);
		const broadcastFn = (event: string, data: any): void => this.broadcast(event, data);
		const _events = initEventsHandlers(() => this.getCurrentPeerCounts(), emitTo);
		const _settings = initSettingsHandlers(this.settings);
		const _datasets = initDatasetsHandlers(this.dataServer);
		const _fs = initFsHandlers();
		this._upload = initUploadHandlers(dataDir);
		const _lishs = initLISHsHandlers(this.dataServer, emitTo, broadcastFn, this.settings);
		const _lishnets = initLISHnetsHandlers(this.networks, this.dataServer, broadcastFn, this.settings, _lishs.importManifest);
		const _identity = initIdentityHandlers(this.networks);
		const _transfer = initTransferHandlers(this.networks, this.dataServer, this.dataDir, emitTo, broadcastFn, this.settings, _lishs.startVerification, _lishs.finalizeDownload);
		const hasSubscribers = (event: string): boolean => {
			for (const client of this.clients) {
				if (client.data.subscribedEvents.has(event) || client.data.subscribedEvents.has('*')) return true;
			}
			return false;
		};
		const _system = initSystemHandlers(this.settings, broadcastFn, hasSubscribers);
		this._system = _system;
		_system.startPolling();
		const _relay = initRelayHandlers(this.networks, broadcastFn, hasSubscribers);
		_relay.startPolling();
		const _search = initSearchManager(this.networks, this.settings, broadcastFn);
		this._search = _search;

		// Factory reset with per-category selection (each defaults to ON, so a
		// plain call wipes everything). Wipes happen at table level — never
		// per-row. On-disk LISH data files are deliberately left untouched, so
		// downloaded and seeded files survive. Connected clients are told to
		// reload since identity, networks and state change.
		const factoryReset = buildFactoryResetHandler({
			dataServer: this.dataServer,
			networks: this.networks,
			settings: this.settings,
			stopVerifyAll: _lishs.stopVerifyAll,
			clearAllTransfers: _transfer.clearAll,
			broadcastFn,
		});

		this.handlers = {
			// Events
			'events.subscribe': _events.subscribe,
			'events.unsubscribe': _events.unsubscribe,
			// Settings
			'settings.get': _settings.get,
			'settings.set': _settings.set,
			'settings.list': _settings.list,
			'settings.getDefaults': _settings.getDefaults,
			'settings.reset': _settings.reset,
			'settings.factoryReset': factoryReset,
			'settings.exportToFile': _settings.exportToFile,
			'settings.parseFromFile': _settings.parseFromFile,
			'settings.parseFromJSON': _settings.parseFromJSON,
			'settings.parseFromURL': _settings.parseFromURL,
			'settings.applyImported': _settings.applyImported,
			// Identity
			'identity.get': _identity.get,
			'identity.exportToFile': _identity.exportToFile,
			'identity.parseFromFile': _identity.parseFromFile,
			'identity.parseFromJSON': _identity.parseFromJSON,
			'identity.parseFromURL': _identity.parseFromURL,
			'identity.applyImported': _identity.applyImported,
			'identity.regenerate': _identity.regenerate,
			// LISH Networks
			'lishnets.list': _lishnets.list,
			'lishnets.get': _lishnets.get,
			'lishnets.exists': _lishnets.exists,
			'lishnets.add': _lishnets.add,
			'lishnets.update': _lishnets.update,
			'lishnets.delete': _lishnets.delete,
			'lishnets.addIfNotExists': _lishnets.addIfNotExists,
			'lishnets.import': _lishnets.import,
			'lishnets.replace': _lishnets.replace,
			'lishnets.exportToFile': _lishnets.exportToFile,
			'lishnets.exportAllToFile': _lishnets.exportAllToFile,
			'lishnets.importFromFile': _lishnets.importFromFile,
			'lishnets.parseFromFile': _lishnets.parseFromFile,
			'lishnets.parseFromJSON': _lishnets.parseFromJSON,
			'lishnets.parseFromURL': _lishnets.parseFromURL,
			'lishnets.setEnabled': _lishnets.setEnabled,
			'lishnets.connect': _lishnets.connect,
			'lishnets.findPeer': _lishnets.findPeer,
			'lishnets.getAddresses': _lishnets.getAddresses,
			'lishnets.getPeers': _lishnets.getPeers,
			'lishnets.getPeerLishs': _lishnets.getPeerLishs,
			'lishnets.getPeerLish': _lishnets.getPeerLish,
			'lishnets.addPeerLish': _lishnets.addPeerLish,
			'lishnets.getNodeInfo': _lishnets.getNodeInfo,
			'lishnets.getStatus': _lishnets.getStatus,
			'lishnets.infoAll': _lishnets.infoAll,
			'lishnets.getBootstrapStatus': _lishnets.getBootstrapStatus,
			'lishnets.getAllBootstrapStatuses': _lishnets.getAllBootstrapStatuses,
			'lishnets.updateBootstrapPeers': _lishnets.updateBootstrapPeers,
			// Browse network — LISH search
			'search.startSearch': _search.startSearch,
			'search.cancelSearch': _search.cancelSearch,
			// LISHs
			'lishs.list': _lishs.list,
			'lishs.get': _lishs.get,
			'lishs.exportToFile': _lishs.exportToFile,
			'lishs.exportAllToFile': _lishs.exportAllToFile,
			'lishs.backup': _lishs.backup,
			'lishs.create': _lishs.create,
			'lishs.delete': _lishs.delete,
			'lishs.importFromFile': _lishs.importFromFile,
			'lishs.importFromJSON': _lishs.importFromJSON,
			'lishs.importFromURL': _lishs.importFromURL,
			'lishs.parseFromFile': _lishs.parseFromFile,
			'lishs.parseFromJSON': _lishs.parseFromJSON,
			'lishs.parseFromURL': _lishs.parseFromURL,
			'lishs.verify': _lishs.verify,
			'lishs.verifyAll': _lishs.verifyAll,
			'lishs.stopVerify': _lishs.stopVerify,
			'lishs.stopVerifyAll': _lishs.stopVerifyAll,
			'lishs.stopCreate': _lishs.stopCreate,
			'lishs.move': _lishs.move,
			// Transfer
			'transfer.download': _transfer.download,
			'transfer.disableDownload': _transfer.disableDownload,
			'transfer.enableDownload': _transfer.enableDownload,
			'transfer.disableUpload': _transfer.disableUpload,
			'transfer.enableUpload': _transfer.enableUpload,
			'transfer.getActiveTransfers': _transfer.getActiveTransfers,
			'transfer.subscribePeers': _transfer.subscribePeers,
			'transfer.unsubscribePeers': _transfer.unsubscribePeers,
			'transfer.debugPeers': _transfer.debugPeers,
			'transfer.findPeers': _transfer.findPeers,
			// Datasets
			'datasets.getDatasets': _datasets.getDatasets,
			'datasets.getDataset': _datasets.getDataset,
			// Filesystem
			'fs.info': _fs.info,
			'fs.list': _fs.list,
			'fs.readText': _fs.readText,
			'fs.readCompressed': _fs.readCompressed,
			'fs.delete': _fs.delete,
			'fs.mkdir': _fs.mkdir,
			'fs.open': _fs.open,
			'fs.rename': _fs.rename,
			'fs.exists': _fs.exists,
			'fs.writeText': _fs.writeText,
			'fs.writeCompressed': _fs.writeCompressed,
			// Import file upload
			'upload.begin': this._upload.begin,
			'upload.chunk': this._upload.chunk,
			'upload.end': this._upload.end,
			'upload.abort': this._upload.abort,
			// System
			'system.ram': _system.ram,
			'system.storage': _system.storage,
			'system.cpu': _system.cpu,
			'system.setVolume': _system.setVolume,
			'system.getVolume': _system.getVolume,
			// Relay
			'relay.stats': _relay.stats,
		};
	}

	start(): void {
		const self = this;
		// Uploads are client-supplied bytes on our disk; a form abandoned between
		// picking a file and importing it leaves one behind. Wiping at startup is
		// cheaper and more reliable than a TTL sweeper, and synchronous so no
		// upload can race the removal.
		rmSync(this.uploadDir, { recursive: true, force: true });
		const serverConfig: Parameters<typeof Bun.serve<ClientData>>[0] = {
			port: this.port,
			hostname: this.host,
			// Upper bound on an uploaded import file. Bun's default happens to be
			// the same 128 MiB, but it is stated here because it is the ceiling the
			// client checks against before it starts sending — an import larger
			// than one API message could not be answered anyway.
			maxRequestBodySize: MAX_API_MESSAGE_SIZE,
			fetch(req, server): Response | Promise<Response> | undefined {
				const url = new URL(req.url);
				// Liveness probe used by docker-compose healthcheck and external
				// orchestrators. Placed before auth + per-request log so probes
				// don't need a token and don't pollute traces at probe cadence.
				const probe = handleHealthProbe(req);
				if (probe) return probe;
				console.log(`[API] Incoming request: ${req.method} ${url.pathname}`);
				// A CORS preflight carries no credentials and no body, so it is
				// answered before the token check — the real request still isn't.
				if (req.method === 'OPTIONS') return self.corsOptionsResponse();
				if (url.pathname === '/status') return self.statusResponse(url);
				if (!self.isAuthorized(url)) return self.unauthorizedResponse();
				if (req.method === 'POST' && url.pathname === '/upload') return self.handleUpload(req, url);
				const clientIP = server.requestIP(req)?.address ?? '';
				const upgraded = server.upgrade(req, {
					data: { subscribedEvents: new Set<string>(), isLocalClient: self.localAddresses.has(clientIP) },
				});
				if (upgraded) return undefined;
				return new Response('Expected WebSocket', { status: 400 });
			},
			websocket: {
				// Bun's default is 16 MiB, and an oversized frame closes the socket
				// with nothing the caller can read as an error. Must live inside the
				// `websocket` object — at the top level of the config it type-checks
				// and is then ignored at runtime.
				maxPayloadLength: MAX_API_MESSAGE_SIZE,
				open(ws): void {
					self.clients.add(ws);
					console.log(`[API] Client connected (${self.clients.size} total)`);
				},
				close(ws): void {
					self.clients.delete(ws);
					unsubscribeAllPeers(ws);
					// A socket that drops mid-transfer leaves a half-written temp
					// file with nobody able to finish or delete it.
					self._upload.closeClient(ws);
					console.log(`[API] Client disconnected (${self.clients.size} total)`);
				},
				async message(ws, message): Promise<void> {
					// A binary frame must not be run through toString(): it is a
					// request envelope around raw bytes, and decoding it as UTF-8
					// would replace every invalid sequence before it is ever read.
					await self.handleMessage(ws, message);
				},
			},
		};
		if (this.secure) {
			if (!this.keyFile || !this.certFile) throw new Error('--secure requires --privkey and --pubkey');
			serverConfig.tls = {
				key: Bun.file(this.keyFile),
				cert: Bun.file(this.certFile),
			};
		}
		this.server = Bun.serve<ClientData>(serverConfig);

		const actualPort = this.server.port;

		// Listen for peer count changes and send to subscribed clients
		this.networks.onPeerCountChange = counts => {
			if (this.clients.size === 0) return;
			for (const client of this.clients) this.emit(client, 'peers:count', counts);
		};

		// Broadcast per-network bootstrap status updates (per-peer dial outcomes).
		// Clients use the lishnets:bootstrapStatus event to surface stale-config
		// warnings (configured peerID does not match actual remote identity) and
		// offer remediation actions in the LISH networks settings UI.
		this.networks.onBootstrapStatusChange = (networkID, status) => {
			this.broadcast('lishnets:bootstrapStatus', { networkID, status });
		};

		const protocol = this.secure ? 'wss' : 'ws';
		console.log(`[API] Token authentication ${this.apiToken ? 'enabled' : 'disabled'}`);
		console.log(`[API] WebSocket server listening on ${protocol}://${this.host}:${actualPort}`);
	}

	stop(): void {
		this._search?.stopAll();
		// Stop the volume poll interval and the push monitor (a long-lived pactl
		// subscribe child on Linux) — they must not outlive the API server.
		this._system?.stopPolling();
		if (this.server) {
			this.server.stop();
			this.server = null;
		}
	}

	private isAuthorized(url: URL): boolean {
		if (!this.apiToken) return true;
		return url.searchParams.get('token') === this.apiToken;
	}

	private jsonResponse(data: unknown, status: number = 200): Response {
		return new Response(JSON.stringify(data), {
			status,
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'access-control-allow-origin': '*',
			},
		});
	}

	private corsOptionsResponse(): Response {
		return new Response(null, {
			status: 204,
			headers: {
				'access-control-allow-origin': '*',
				'access-control-allow-methods': 'GET, POST, OPTIONS',
				'access-control-allow-headers': 'content-type',
			},
		});
	}

	/**
	 * Drop uploads nobody ever imported. The client removes its own temp file once
	 * the import is parsed, but a closed tab, a refresh or a lost response leaves
	 * one behind — and on a node that runs for months the startup wipe alone would
	 * let those pile up until the disk is full. Runs on each upload rather than on
	 * a timer, because uploads are the only thing that creates them. Never throws:
	 * a failed sweep must not fail the upload it was making room for.
	 */
	private async sweepUploads(): Promise<void> {
		const cutoff = Date.now() - UPLOAD_MAX_AGE_MS;
		try {
			for (const name of await readdir(this.uploadDir)) {
				const path = join(this.uploadDir, name);
				// A file still being uploaded has a current mtime, so it is never swept.
				try {
					if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
				} catch {}
			}
		} catch {}
	}

	/**
	 * Accept one import file over plain HTTP and land it in a temp file under the
	 * data directory. The client then imports it through the existing
	 * `*.parseFromFile` handlers, so the file crosses the wire once instead of
	 * being base64'd into a WebSocket frame and echoed back as text.
	 */
	private async handleUpload(req: globalThis.Request, url: URL): Promise<Response> {
		const path = join(this.uploadDir, uploadFileName(url.searchParams.get('name') ?? 'upload'));
		try {
			await mkdir(this.uploadDir, { recursive: true });
			await this.sweepUploads();
			const writer = Bun.file(path).writer();
			let written = 0;
			let tooLarge = false;
			try {
				// Streamed chunk by chunk so a large import never has to sit in
				// memory as a whole. `Bun.write(path, new Response(req.body))` would
				// read better but deadlocks on Bun 1.3.13 — measured, not guessed.
				if (req.body) {
					for await (const chunk of req.body) {
						written += chunk.byteLength;
						// `maxRequestBodySize` only covers a body that declares its
						// length; a chunked upload carries none and would otherwise be
						// free to fill the disk. Measured on Bun 1.3.13: 320 MiB written
						// against a 128 MiB limit before this check existed.
						if (written > MAX_API_MESSAGE_SIZE) {
							tooLarge = true;
							break;
						}
						writer.write(chunk);
					}
				}
			} finally {
				// Also releases the file handle, which Windows needs before the
				// half-written file can be removed on the error path below.
				await writer.end();
			}
			if (tooLarge) {
				rmSync(path, { force: true });
				console.error(`[API] Upload rejected: body exceeds ${MAX_API_MESSAGE_SIZE} bytes`);
				return this.jsonResponse({ error: ErrorCodes.MESSAGE_TOO_LARGE, errorDetail: formatBytes(MAX_API_MESSAGE_SIZE) }, 413);
			}
			console.log(`[API] Upload stored: ${path} (${Bun.file(path).size} bytes)`);
			return this.jsonResponse({ path });
		} catch (err: any) {
			// A failed cleanup must not replace the error that caused it.
			try {
				rmSync(path, { force: true });
			} catch {}
			console.error(`[API] Upload failed: ${err.message}`);
			return this.jsonResponse({ error: ErrorCodes.FS_ERROR, errorDetail: err.message }, 500);
		}
	}

	private unauthorizedResponse(): Response {
		return this.jsonResponse({ ok: false, authRequired: true, authenticated: false, error: 'UNAUTHORIZED' }, 401);
	}

	private statusResponse(url: URL): Response {
		const authRequired = !!this.apiToken;
		const authenticated = this.isAuthorized(url);
		return this.jsonResponse(
			{
				ok: authenticated,
				authRequired,
				authenticated,
				...(authenticated ? {} : { error: 'UNAUTHORIZED' }),
			},
			authenticated ? 200 : 401
		);
	}

	private async handleMessage(client: ClientSocket, message: string | Buffer): Promise<void> {
		let req: Request;
		try {
			req = typeof message === 'string' ? JSON.parse(message) : decodeBinaryRequest(message);
		} catch {
			client.send(JSON.stringify({ id: null, error: ErrorCodes.PARSE_ERROR }));
			return;
		}

		if (!req.method) {
			client.send(JSON.stringify({ id: req.id, error: ErrorCodes.METHOD_REQUIRED }));
			return;
		}

		try {
			const result = await this.execute(client, req.method, req.params || {});
			client.send(JSON.stringify({ id: req.id, result }));
		} catch (err: any) {
			console.error(`[API] Error executing ${req.method}, params=${formatParamsForLog(req.params)}: ${err.message}`);
			if (err instanceof CodedError) client.send(JSON.stringify({ id: req.id, error: err.code, ...(err.detail !== undefined && { errorDetail: err.detail }) }));
			else client.send(JSON.stringify({ id: req.id, error: ErrorCodes.INTERNAL_ERROR, errorDetail: err.message }));
		}
	}

	// --- API dispatch table and core handlers ---
	private handlers!: Record<string, (params: any, client: ClientSocket) => any>;

	private async execute(client: ClientSocket, method: string, params: Record<string, any>): Promise<any> {
		console.log(`[API] Executing method: ${method}, params: ${formatParamsForLog(params)}`);
		const handler = this.handlers[method];
		if (!handler) throw new CodedError(ErrorCodes.UNKNOWN_METHOD, method);
		return handler.call(this, params, client);
	}

	private getCurrentPeerCounts(): PeerCountEntry[] {
		const enabled = this.networks.getEnabled();
		return enabled.map(net => {
			const health = this.networks.getMeshHealth(net.networkID);
			return {
				networkID: net.networkID,
				count: this.networks.getTopicPeers(net.networkID).length,
				meshSize: health.meshSize,
				stableSinceMs: health.stableSinceMs,
				medianScore: health.medianScore,
			};
		});
	}

	private emit(client: ClientSocket, event: string, data: any): void {
		if (client.data.subscribedEvents.has(event) || client.data.subscribedEvents.has('*')) client.send(JSON.stringify({ event, data }));
	}

	broadcastEvent(event: string, data: any): void {
		this.broadcast(event, data);
	}

	private broadcast(event: string, data: any): void {
		const msg = JSON.stringify({ event, data });
		let sent = 0;
		for (const client of this.clients) {
			if (client.data.subscribedEvents.has(event) || client.data.subscribedEvents.has('*')) {
				client.send(msg);
				sent++;
			}
		}
		if (event.startsWith('transfer.')) {
			const d = data as any;
			const extra = d.peers !== undefined ? ` peers=${d.peers}` : '';
			const speed = d.bytesPerSecond !== undefined ? ` speed=${Math.round(d.bytesPerSecond / 1024)}KB/s` : '';
			const chunks = d.downloadedChunks !== undefined ? ` ${d.downloadedChunks}/${d.totalChunks}` : '';
			console.log(`[TRANSFER] ${event}${chunks}${extra}${speed} → ${sent}/${this.clients.size} clients`);
		}
	}
}
