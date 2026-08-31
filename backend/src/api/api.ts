import { type ServerWebSocket } from 'bun';
import { Mutex } from 'async-mutex';
import { type DataServer } from '../lish/data-server.ts';
import { type Networks } from '../lishnet/lishnets.ts';
import type { PeerCountEntry } from '../protocol/network.ts';
import { type Settings } from '../settings.ts';
import { CodedError, type ErrorCode, ErrorCodes, MAX_API_MESSAGE_SIZE, MAX_UPLOAD_CHUNK_SIZE, formatBytes } from '@shared';
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

/** Longest params blob written to the log; enough to identify a call, short of dumping a file upload. */
const MAX_LOGGED_PARAMS = 1000;
/** Request fields whose values must never reach logs, regardless of nesting. */
const SENSITIVE_PARAM_NAME = /(?:password|passphrase|token|secret|authorization|api[-_]?key)/i;

/**
 * Serialise request params for the log, truncated. Some methods carry a whole
 * file chunk, and a multi-megabyte log line per call is both unreadable and a
 * measurable write cost — the truncation alone would not help, because the
 * megabytes are spent building the string before it is cut. A binary payload is
 * always a plain `Uint8Array` (see {@link decodeBinaryRequest}), never a
 * `Buffer`, whose `toJSON` would run before this replacer ever sees it.
 */
export function formatParamsForLog(params: unknown): string {
	const json =
		JSON.stringify(params, (key, value) => {
			if (key && SENSITIVE_PARAM_NAME.test(key)) return '[REDACTED]';
			return value instanceof Uint8Array ? `<${value.byteLength} bytes>` : value;
		}) ?? String(params);
	return json.length <= MAX_LOGGED_PARAMS ? json : json.slice(0, MAX_LOGGED_PARAMS) + `…(${json.length} chars)`;
}

/** Host network administration always requires the authenticated API mode. */
export function canAdministerHostNetwork(apiTokenConfigured: boolean): boolean {
	return apiTokenConfigured;
}

/** Match Bun's peer address against loopback and every address owned by this host. */
export function isLocalClientAddress(clientIP: string, localAddresses: ReadonlySet<string>): boolean {
	return localAddresses.has(clientIP);
}

/** Byte length of the header-length prefix on a binary request frame. */
const BINARY_HEADER_PREFIX = 4;

/**
 * Direct imports — those that did not arrive as an upload — that may be waiting
 * for the parser at once. An upload import is deliberately not counted here: its
 * file is already on our disk and already charged against the upload ceilings,
 * so refusing it at this queue would be a second and harsher limit on work that
 * has been admitted.
 *
 * This bounds the queue, not peak memory. A request's payload is parsed out of
 * the frame before any handler runs, so it exists before this check can refuse
 * it — what the bound stops is that cost being multiplied by an unlimited number
 * of waiters.
 */
const MAX_QUEUED_IMPORTS = 8;

/**
 * True for a dispatch table entry that parses an import and therefore has to
 * queue behind every other one.
 *
 * Decided from the method name rather than by wrapping entries one at a time as
 * the table is written. That list was opt-in and four handlers were left off
 * it — the legacy `importFrom*` set, which parses exactly like its `parseFrom*`
 * neighbours — so they ran beside a serialised parse and undid the point of the
 * lock. A name cannot be forgotten in the same way.
 *
 * `parseFromUpload` is the one exclusion: it reaches the same lock further down,
 * inside `withFile`, where it also keeps the upload's disk accounting open while
 * it waits. Taking a non-reentrant mutex twice would deadlock the first upload
 * import.
 */
export function isSerialisedImport(method: string): boolean {
	return /\.(parseFrom|importFrom)/.test(method) && !method.endsWith('.parseFromUpload');
}

/**
 * Put every import entry in a dispatch table behind the shared parser lock, in
 * place. Applied to the whole table once it is built rather than written around
 * individual entries as they are added, which is what makes it impossible to
 * add an import RPC and forget the lock.
 *
 * Exported so the wiring can be exercised on its own: the real table is built in
 * the {@link APIServer} constructor, which wants a database, a network stack and
 * a data server before it will hand one over.
 */
export function serialiseImportHandlers(handlers: Record<string, (p: any, client: ClientSocket) => any>, lock: Mutex, isConnected: (client: ClientSocket) => boolean = () => true, maxQueued: number = MAX_QUEUED_IMPORTS): void {
	let queued = 0;
	for (const method of Object.keys(handlers)) {
		if (!isSerialisedImport(method)) continue;
		const handler = handlers[method]!;
		handlers[method] = async (p: any, client: ClientSocket): Promise<any> => {
			// Refused rather than queued once the queue is full. `runExclusive` waits
			// without limit, and each waiter holds its whole request alive for as long
			// as it waits — so an unbounded queue is an unbounded number of import
			// payloads in memory, which is the thing the lock exists to keep down.
			if (queued >= maxQueued) throw new CodedError(ErrorCodes.IMPORT_BUSY, String(maxQueued));
			queued++;
			try {
				// The handler goes straight to its domain implementation, never back
				// through this table, so nothing re-enters the lock it is holding.
				return await lock.runExclusive(async () => {
					// The wait has no time bound, so the caller may well be gone by the
					// time the lock comes free — and parsing an import nobody is left to
					// answer is the expensive half of the operation spent on nothing.
					if (!isConnected(client)) throw new CodedError(ErrorCodes.CLIENT_DISCONNECTED, method);
					return await handler(p, client);
				});
			} finally {
				queued--;
			}
		};
	}
}

/**
 * Largest JSON header accepted on a binary frame. The header is a short
 * `{ id, method, params }` envelope — 64 KiB is orders of magnitude more than
 * one needs, and the cap stops a frame from forcing a huge `TextDecoder` pass
 * and `JSON.parse` before anything about it has been validated.
 */
export const MAX_BINARY_HEADER_SIZE: number = 64 * 1024;

/**
 * A binary frame rejected after its header was understood, so the reply can
 * still carry the request id. Without the id the caller's promise is never
 * settled by anything but a socket close, since responses are correlated by id
 * alone.
 */
export class BinaryFrameError extends CodedError {
	readonly requestID: string | null;

	constructor(code: ErrorCode, detail: string, requestID: string | null) {
		super(code, detail);
		this.requestID = requestID;
	}
}

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
	// Both bounds are checked before any decoding or copying: the transport
	// allows a frame far bigger than any legitimate chunk, and an oversized one
	// must cost a length comparison rather than a full second copy of itself.
	if (headerLength > MAX_BINARY_HEADER_SIZE) throw new CodedError(ErrorCodes.PARSE_ERROR);
	const payloadStart = BINARY_HEADER_PREFIX + headerLength;
	if (payloadStart > frame.byteLength) throw new CodedError(ErrorCodes.PARSE_ERROR);
	// The header is bounded and cheap, so it is parsed first — that way an
	// oversized payload is still rejected with the id the caller is waiting on.
	const req = JSON.parse(new TextDecoder().decode(frame.subarray(BINARY_HEADER_PREFIX, payloadStart))) as Request;
	if (!req || typeof req !== 'object' || Array.isArray(req)) throw new CodedError(ErrorCodes.PARSE_ERROR);
	if (req.params !== undefined && (!req.params || typeof req.params !== 'object' || Array.isArray(req.params))) throw new BinaryFrameError(ErrorCodes.PARSE_ERROR, 'params must be an object', typeof req.id === 'string' ? req.id : null);
	// Checked before the copy below, which is the allocation worth avoiding.
	if (frame.byteLength - payloadStart > MAX_UPLOAD_CHUNK_SIZE) throw new BinaryFrameError(ErrorCodes.UPLOAD_CHUNK_TOO_LARGE, formatBytes(MAX_UPLOAD_CHUNK_SIZE), req.id ?? null);
	req.params = { ...req.params, data: new Uint8Array(frame.subarray(payloadStart)) };
	return req;
}

export class APIServer {
	private clients: Set<ClientSocket> = new Set();
	private server: ReturnType<typeof Bun.serve<ClientData>> | null = null;
	private readonly settings: Settings;
	private readonly host: string;
	private readonly port: number;
	private readonly secure: boolean;
	private readonly keyFile?: string | undefined;
	private readonly certFile?: string | undefined;
	private readonly apiToken?: string | undefined;
	private readonly dataDir: string;
	private readonly dataServer: DataServer;
	private readonly networks: Networks;
	private readonly _upload: ReturnType<typeof initUploadHandlers>;
	/**
	 * Serialises parsing an import, however the file arrived. Parsing is where the
	 * memory actually goes: the file is held as a buffer, decompressed into a
	 * second buffer, decoded into a string and then parsed into an object graph,
	 * and the last two are usually several times the file. Chunking bounds what
	 * arrives on the wire, not that.
	 *
	 * Taken by every import entry point, uploaded or not — the uploaded ones reach
	 * it inside `withFile`, the rest through {@link serialiseImportHandlers}.
	 *
	 * What it guarantees is one parse body at a time. That is not a ceiling on
	 * peak memory, and nothing here should be read as claiming one: this server
	 * runs `JSON.parse` over the whole request frame before any handler is
	 * reached, so a large `parseFromJSON` argument already exists in memory before
	 * the lock can delay anything, and the previous import's object graph is still
	 * being serialised into its reply when the next parse starts. A real ceiling
	 * would mean streaming the request body and holding the permit across the
	 * response write.
	 */
	private readonly importLock = new Mutex();
	private _search: ReturnType<typeof import('./search.ts').initSearchManager> | null = null;
	private _system: ReturnType<typeof import('./system.ts').initSystemHandlers> | null = null;

	constructor(dataDir: string, dataServer: DataServer, networks: Networks, settings: Settings, options: APIServerOptions) {
		this.dataDir = dataDir;
		this.dataServer = dataServer;
		this.networks = networks;
		this.settings = settings;
		this.host = options.host;
		this.port = options.port;
		this.secure = options.secure;
		this.keyFile = options.keyFile;
		this.certFile = options.certFile;
		this.apiToken = options.apiToken || undefined;
		const emitTo = (client: ClientSocket, event: string, data: any): void => this.emit(client, event, data);
		const broadcastFn = (event: string, data: any): void => this.broadcast(event, data);
		const broadcastExceptFn = (event: string, data: any, except?: unknown): void => this.broadcast(event, data, except as ClientSocket | undefined);
		const _events = initEventsHandlers(() => this.getCurrentPeerCounts(), emitTo);
		const _settings = initSettingsHandlers(this.settings);
		const _datasets = initDatasetsHandlers(this.dataServer);
		const _fs = initFsHandlers();
		this._upload = initUploadHandlers(dataDir, {}, this.importLock);
		const _lishs = initLISHsHandlers(this.dataServer, emitTo, broadcastFn, this.settings);
		const _lishnets = initLISHnetsHandlers(this.networks, this.dataServer, broadcastFn, this.settings, _lishs.importManifest, _lishs.runMutation);
		const _identity = initIdentityHandlers(this.networks);
		const _transfer = initTransferHandlers(this.networks, this.dataServer, this.dataDir, emitTo, broadcastFn, this.settings, _lishs.startVerification, _lishs.finalizeDownloadAdmitted);
		const hasSubscribers = (event: string): boolean => {
			for (const client of this.clients) {
				if (client.data.subscribedEvents.has(event) || client.data.subscribedEvents.has('*')) return true;
			}
			return false;
		};
		const _system = initSystemHandlers(this.settings, broadcastFn, hasSubscribers, !!this.apiToken);
		const networkAdmin = <P, R>(handler: (params: P) => R): ((params: P, client: ClientSocket) => R) => {
			return params => {
				if (!canAdministerHostNetwork(!!this.apiToken)) throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'host network administration requires API authentication');
				return handler(params);
			};
		};
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
			pauseAllLISHMutations: _lishs.pauseMutations,
			resumeAllLISHMutations: _lishs.resumeMutations,
			pauseAllTransfers: _transfer.pauseAll,
			clearAllTransfers: _transfer.clearAll,
			clearUploadRuntime: _transfer.clearUploads,
			restoreAllTransfers: _transfer.restoreAll,
			resumeAllTransfers: _transfer.resumeAll,
			broadcastFn: broadcastExceptFn,
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
			'settings.parseFromUpload': (p, client) => this._upload.withFile(p, client, filePath => _settings.parseFromFile({ filePath })),
			'settings.parseFromJSON': _settings.parseFromJSON,
			'settings.parseFromURL': _settings.parseFromURL,
			'settings.applyImported': _settings.applyImported,
			// Identity
			'identity.get': _identity.get,
			'identity.exportToFile': _identity.exportToFile,
			'identity.parseFromFile': _identity.parseFromFile,
			'identity.parseFromUpload': (p, client) => this._upload.withFile(p, client, filePath => _identity.parseFromFile({ filePath })),
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
			'lishnets.parseFromUpload': (p, client) => this._upload.withFile(p, client, path => _lishnets.parseFromFile({ path })),
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
			'lishs.parseFromUpload': (p, client) => this._upload.withFile(p, client, filePath => _lishs.parseFromFile({ filePath })),
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
			'system.network': _system.network,
			'system.networkApply': networkAdmin(_system.networkApply),
			'system.wifiScan': networkAdmin(_system.wifiScan),
			'system.wifiConnect': networkAdmin(_system.wifiConnect),
			// Relay
			'relay.stats': _relay.stats,
		};
		serialiseImportHandlers(this.handlers, this.importLock, client => this.clients.has(client));
	}

	start(): void {
		const self = this;
		// Uploads are client-supplied bytes on our disk, and a transfer interrupted
		// by a kill leaves one behind with nobody left to abort it.
		this._upload.wipe();
		const serverConfig: Parameters<typeof Bun.serve<ClientData>>[0] = {
			port: this.port,
			hostname: this.host,
			fetch(req, server): Response | undefined {
				const url = new URL(req.url);
				// Liveness probe used by docker-compose healthcheck and external
				// orchestrators. Placed before auth + per-request log so probes
				// don't need a token and don't pollute traces at probe cadence.
				const probe = handleHealthProbe(req);
				if (probe) return probe;
				console.log(`[API] Incoming request: ${req.method} ${url.pathname}`);
				if (req.method === 'OPTIONS' && url.pathname === '/status') return self.statusOptionsResponse();
				if (url.pathname === '/status') return self.statusResponse(url);
				if (!self.isAuthorized(url)) return self.unauthorizedResponse();
				const clientIP = server.requestIP(req)?.address ?? '';
				const upgraded = server.upgrade(req, {
					data: { subscribedEvents: new Set<string>(), isLocalClient: isLocalClientAddress(clientIP, getLocalAddresses()) },
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
		// The upload sweep is a long-lived interval and must not outlive the server.
		this._upload.stop();
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

	private statusOptionsResponse(): Response {
		return new Response(null, {
			status: 204,
			headers: {
				'access-control-allow-origin': '*',
				'access-control-allow-methods': 'GET, OPTIONS',
				'access-control-allow-headers': 'content-type',
			},
		});
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
		} catch (err) {
			// A frame rejected on a real limit reports that limit rather than a
			// blanket parse failure, and carries the request id when the decoder got
			// far enough to read one — otherwise the caller waits for a reply that
			// can never be matched to it.
			const coded = err instanceof CodedError ? err : null;
			const id = err instanceof BinaryFrameError ? err.requestID : null;
			client.send(JSON.stringify({ id, error: coded?.code ?? ErrorCodes.PARSE_ERROR, ...(coded?.detail !== undefined && { errorDetail: coded.detail }) }));
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

	/**
	 * Send `event` to every subscribed client, optionally skipping one.
	 *
	 * `except` exists for events whose whole point is "somebody else did this": the client
	 * that asked gets the RPC answer and acts on that, and would only be talked over by the
	 * broadcast — a factory reset reloading the very tab that is about to show its result.
	 */
	private broadcast(event: string, data: any, except?: ClientSocket): void {
		const msg = JSON.stringify({ event, data });
		let sent = 0;
		for (const client of this.clients) {
			if (client === except) continue;
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
