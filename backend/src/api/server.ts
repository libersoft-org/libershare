import { type ServerWebSocket } from 'bun';
import { type DataServer } from '../lish/data-server.ts';
import { type Networks } from '../lishnet/networks.ts';
import { type Settings } from '../settings.ts';
import { initSettingsHandlers } from './settings.ts';
import { initLISHnetsHandlers } from './lishnets.ts';
import { initDatasetsHandlers } from './datasets.ts';
import { initFsHandlers } from './fs.ts';
import { initLISHsHandlers } from './lishs.ts';
import { initTransferHandlers } from './transfer.ts';
import { initCoreHandlers } from './core.ts';
import { initEventsHandlers } from './events.ts';
interface ClientData {
	subscribedEvents: Set<string>;
}
type ClientSocket = ServerWebSocket<ClientData>;
interface Request {
	id: string | number;
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
	private readonly keyFile?: string;
	private readonly certFile?: string;

	constructor(
		private readonly dataDir: string,
		private readonly dataServer: DataServer,
		private readonly networks: Networks,
		settings: Settings,
		options: APIServerOptions
	) {
		this.settings = settings;
		this.host = options.host;
		this.port = options.port;
		this.secure = options.secure;
		this.keyFile = options.keyFile;
		this.certFile = options.certFile;

		const emitTo = (client: ClientSocket, event: string, data: any) => this.emit(client, event, data);

		const _events = initEventsHandlers(() => this.getCurrentPeerCounts(), emitTo);
		const _core = initCoreHandlers();
		const _settings = initSettingsHandlers(this.settings);
		const _lishnets = initLISHnetsHandlers(this.networks, this.dataServer);
		const _datasets = initDatasetsHandlers(this.dataServer);
		const _fs = initFsHandlers();
		const _lishs = initLISHsHandlers(this.dataServer, emitTo);
		const _transfer = initTransferHandlers(this.networks, this.dataServer, this.dataDir, emitTo);

		this.handlers = {
			// Core
			fetchUrl: _core.fetchUrl,

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
			'lishnets.importFromFile': _lishnets.importFromFile,
			'lishnets.importFromJson': _lishnets.importFromJson,
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
			'lishs.create': _lishs.create,

			// Transfer
			'transfer.download': _transfer.download,

			// Datasets
			'datasets.getDatasets': _datasets.getDatasets,
			'datasets.getDataset': _datasets.getDataset,

			// Filesystem
			'fs.info': _fs.info,
			'fs.list': _fs.list,
			'fs.readText': _fs.readText,
			'fs.readGzip': _fs.readGzip,
			'fs.delete': _fs.delete,
			'fs.mkdir': _fs.mkdir,
			'fs.open': _fs.open,
			'fs.rename': _fs.rename,
			'fs.exists': _fs.exists,
			'fs.writeText': _fs.writeText,
			'fs.writeGzip': _fs.writeGzip,
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
			for (const client of this.clients) {
				this.emit(client, 'peers:count', counts);
			}
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
			client.send(JSON.stringify({ id: null, error: 'Parse error' }));
			return;
		}

		if (!req.method) {
			client.send(JSON.stringify({ id: req.id, error: 'Method required' }));
			return;
		}

		try {
			const result = await this.execute(client, req.method, req.params || {});
			client.send(JSON.stringify({ id: req.id, result }));
		} catch (err: any) {
			console.error(`[API] Error executing ${req.method}, params=${JSON.stringify(req.params)}: ${err.message}`);
			client.send(JSON.stringify({ id: req.id, error: err.message }));
		}
	}

	// --- API dispatch table and core handlers ---
	private handlers!: Record<string, (params: Record<string, any>, client: ClientSocket) => Promise<any> | any>;

	private async execute(client: ClientSocket, method: string, params: Record<string, any>): Promise<any> {
		console.log(`[API] Executing method: ${method}, params: ${JSON.stringify(params)}`);
		const handler = this.handlers[method];
		if (!handler) throw new Error(`Unknown method: ${method}`);
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
}
