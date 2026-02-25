import { type ServerWebSocket } from 'bun';
import { type DataServer } from '../lish/data-server.ts';
import { type Networks } from '../lishnet/networks.ts';
import { type Settings } from '../settings.ts';
import { type LISHNetworkStorage } from '../lishnet/lishNetworkStorage.ts';
import { initSettingsHandlers } from './settings.ts';
import { initLishNetworksHandlers } from './lishNetworks.ts';
import { initNetworksHandlers } from './networks.ts';
import { initDatasetsHandlers } from './datasets.ts';
import { initFsHandlers } from './fs.ts';
import { initLishsHandlers } from './lishs.ts';
import { initTransferHandlers } from './transfer.ts';
import { initCoreHandlers } from './core.ts';
interface ClientData {
	subscribedEvents: Set<string>;
}
type ClientSocket = ServerWebSocket<ClientData>;
interface Request {
	id: string | number;
	method: string;
	params?: Record<string, any>;
}
export interface ApiServerOptions {
	host: string;
	port: number;
	secure: boolean;
	keyFile: string | undefined;
	certFile: string | undefined;
}

export class ApiServer {
	private clients: Set<ClientSocket> = new Set();
	private server: ReturnType<typeof Bun.serve<ClientData>> | null = null;
	private readonly settings: Settings;
	private readonly lishNetworks: LISHNetworkStorage;
	private readonly host: string;
	private readonly port: number;
	private readonly secure: boolean;
	private readonly keyFile?: string;
	private readonly certFile?: string;

	constructor(
		private readonly dataDir: string,
		private readonly dataServer: DataServer,
		private readonly networks: Networks,
		lishNetworks: LISHNetworkStorage,
		settings: Settings,
		options: ApiServerOptions
	) {
		this.settings = settings;
		this.lishNetworks = lishNetworks;
		this.host = options.host;
		this.port = options.port;
		this.secure = options.secure;
		this.keyFile = options.keyFile;
		this.certFile = options.certFile;

		const emitTo = (client: ClientSocket, event: string, data: any) => this.emit(client, event, data);

		const _core = initCoreHandlers(() => this.getCurrentPeerCounts(), emitTo);
		const _settings = initSettingsHandlers(this.settings);
		const _lishNetworks = initLishNetworksHandlers(this.lishNetworks);
		const _networks = initNetworksHandlers(this.networks, this.dataServer);
		const _datasets = initDatasetsHandlers(this.dataServer);
		const _fs = initFsHandlers();
		const _lishs = initLishsHandlers(this.dataServer, emitTo);
		const _transfer = initTransferHandlers(this.networks, this.dataServer, this.dataDir, emitTo);

		this.handlers = {
			// Core
			subscribe: _core.subscribe,
			unsubscribe: _core.unsubscribe,
			fetchUrl: _core.fetchUrl,

			// Settings
			'settings.get': _settings.get,
			'settings.set': _settings.set,
			'settings.getAll': _settings.getAll,
			'settings.getDefaults': _settings.getDefaults,
			'settings.reset': _settings.reset,

			// LISH Networks
			'lishNetworks.getAll': _lishNetworks.getAll,
			'lishNetworks.get': _lishNetworks.get,
			'lishNetworks.exists': _lishNetworks.exists,
			'lishNetworks.add': _lishNetworks.add,
			'lishNetworks.update': _lishNetworks.update,
			'lishNetworks.delete': _lishNetworks.delete,
			'lishNetworks.addIfNotExists': _lishNetworks.addIfNotExists,
			'lishNetworks.import': _lishNetworks.import,
			'lishNetworks.setAll': _lishNetworks.setAll,

			// Networks
			'networks.list': _networks.list,
			'networks.get': _networks.get,
			'networks.importFromFile': _networks.importFromFile,
			'networks.importFromJson': _networks.importFromJson,
			'networks.setEnabled': _networks.setEnabled,
			'networks.delete': _networks.delete,
			'networks.connect': _networks.connect,
			'networks.findPeer': _networks.findPeer,
			'networks.getAddresses': _networks.getAddresses,
			'networks.getPeers': _networks.getPeers,
			'networks.getNodeInfo': _networks.getNodeInfo,
			'networks.getStatus': _networks.getStatus,
			'networks.infoAll': _networks.infoAll,

			// LISHs
			'lishs.getAll': _lishs.getAll,
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
			fetch(req, server) {
				console.log(`[API] Incoming request: ${req.method} ${req.url}`);
				const upgraded = server.upgrade(req, {
					data: { subscribedEvents: new Set<string>() },
				});
				if (upgraded) return undefined;
				return new Response('Expected WebSocket', { status: 400 });
			},
			websocket: {
				open(ws) {
					self.clients.add(ws);
					console.log(`[API] Client connected (${self.clients.size} total)`);
				},
				close(ws) {
					self.clients.delete(ws);
					console.log(`[API] Client disconnected (${self.clients.size} total)`);
				},
				async message(ws, message) {
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
		return enabled.map(def => ({
			networkID: def.id,
			count: this.networks.getTopicPeers(def.id).length,
		}));
	}

	private emit(client: ClientSocket, event: string, data: any): void {
		if (client.data.subscribedEvents.has(event) || client.data.subscribedEvents.has('*')) client.send(JSON.stringify({ event, data }));
	}
}
