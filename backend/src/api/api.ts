import { type ServerWebSocket } from 'bun';
import { type DataServer } from '../lish/data-server.ts';
import { type Networks } from '../lishnet/lishnets.ts';
import { type Settings } from '../settings.ts';
import { CodedError, ErrorCodes } from '@shared';
import { initSettingsHandlers } from './settings.ts';
import { initLISHnetsHandlers } from './lishnets.ts';
import { initDatasetsHandlers } from './datasets.ts';
import { initFsHandlers } from './fs.ts';
import { initLISHsHandlers } from './lishs.ts';
import { initTransferHandlers } from './transfer.ts';
import { initEventsHandlers } from './events.ts';
import { initSystemHandlers } from './system.ts';
interface ClientData {
	subscribedEvents: Set<string>;
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
	private readonly dataDir: string;
	private readonly dataServer: DataServer;
	private readonly networks: Networks;

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
		const emitTo = (client: ClientSocket, event: string, data: any) => this.emit(client, event, data);
		const broadcastFn = (event: string, data: any) => this.broadcast(event, data);
		const _events = initEventsHandlers(() => this.getCurrentPeerCounts(), emitTo);
		const _settings = initSettingsHandlers(this.settings);
		const _lishnets = initLISHnetsHandlers(this.networks, this.dataServer, broadcastFn);
		const _datasets = initDatasetsHandlers(this.dataServer);
		const _fs = initFsHandlers();
		const _lishs = initLISHsHandlers(this.dataServer, emitTo, broadcastFn);
		const _transfer = initTransferHandlers(this.networks, this.dataServer, this.dataDir, emitTo, broadcastFn);
		const hasSubscribers = (event: string): boolean => {
			for (const client of this.clients) {
				if (client.data.subscribedEvents.has(event) || client.data.subscribedEvents.has('*')) return true;
			}
			return false;
		};
		const _system = initSystemHandlers(this.settings, broadcastFn, hasSubscribers);
		_system.startPolling();
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
			'lishnets.getNodeInfo': _lishnets.getNodeInfo,
			'lishnets.getStatus': _lishnets.getStatus,
			'lishnets.infoAll': _lishnets.infoAll,
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
			// System
			'system.ram': _system.ram,
			'system.storage': _system.storage,
			'system.cpu': _system.cpu,
		};
	}

	start(): void {
		const self = this;
		const serverConfig: Parameters<typeof Bun.serve<ClientData>>[0] = {
			port: this.port,
			hostname: this.host,
			fetch(req, server): Response | undefined {
				console.log(`[API] Incoming request: ${req.method} ${req.url}`);
				const upgraded = server.upgrade(req, {
					data: { subscribedEvents: new Set<string>() },
				});
				if (upgraded) return undefined;
				return new Response('Expected WebSocket', { status: 400 });
			},
			websocket: {
				open(ws): void {
					self.clients.add(ws);
					console.log(`[API] Client connected (${self.clients.size} total)`);
				},
				close(ws): void {
					self.clients.delete(ws);
					console.log(`[API] Client disconnected (${self.clients.size} total)`);
				},
				async message(ws, message): Promise<void> {
					await self.handleMessage(ws, message.toString());
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

		const protocol = this.secure ? 'wss' : 'ws';
		console.log(`[API] WebSocket server listening on ${protocol}://${this.host}:${actualPort}`);
	}

	stop(): void {
		if (this.server) {
			this.server.stop();
			this.server = null;
		}
	}

	private async handleMessage(client: ClientSocket, message: string): Promise<void> {
		let req: Request;
		try {
			req = JSON.parse(message);
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
			console.error(`[API] Error executing ${req.method}, params=${JSON.stringify(req.params)}: ${err.message}`);
			if (err instanceof CodedError) client.send(JSON.stringify({ id: req.id, error: err.code, ...(err.detail !== undefined && { errorDetail: err.detail }) }));
			else client.send(JSON.stringify({ id: req.id, error: ErrorCodes.INTERNAL_ERROR, errorDetail: err.message }));
		}
	}

	// --- API dispatch table and core handlers ---
	private handlers!: Record<string, (params: any, client: ClientSocket) => any>;

	private async execute(client: ClientSocket, method: string, params: Record<string, any>): Promise<any> {
		console.log(`[API] Executing method: ${method}, params: ${JSON.stringify(params)}`);
		const handler = this.handlers[method];
		if (!handler) throw new CodedError(ErrorCodes.UNKNOWN_METHOD, method);
		return handler.call(this, params, client);
	}

	private getCurrentPeerCounts(): { networkID: string; count: number }[] {
		const enabled = this.networks.getEnabled();
		return enabled.map(net => ({
			networkID: net.networkID,
			count: this.networks.getTopicPeers(net.networkID).length,
		}));
	}

	private emit(client: ClientSocket, event: string, data: any): void {
		if (client.data.subscribedEvents.has(event) || client.data.subscribedEvents.has('*')) client.send(JSON.stringify({ event, data }));
	}

	broadcastEvent(event: string, data: any): void { this.broadcast(event, data); }

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
			const speed = d.bytesPerSecond !== undefined ? ` speed=${Math.round(d.bytesPerSecond/1024)}KB/s` : '';
			const chunks = d.downloadedChunks !== undefined ? ` ${d.downloadedChunks}/${d.totalChunks}` : '';
			console.log(`[TRANSFER] ${event}${chunks}${extra}${speed} → ${sent}/${this.clients.size} clients`);
		}
	}
}
