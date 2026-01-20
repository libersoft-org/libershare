import type { ServerWebSocket } from 'bun';
import type { Database } from './database.ts';
import type { DataServer } from './data-server.ts';
import type { Networks } from './networks.ts';
import { Downloader } from './downloader.ts';
import { join } from 'path';

const API_PORT = parseInt(process.env.API_PORT || '1158', 10);

interface ClientData {
	subscribedEvents: Set<string>;
}

type ClientSocket = ServerWebSocket<ClientData>;

interface Request {
	id: string | number;
	method: string;
	params?: Record<string, any>;
}

export class ApiServer {
	private clients: Set<ClientSocket> = new Set();
	private server: ReturnType<typeof Bun.serve<ClientData>> | null = null;

	constructor(
		private readonly dataDir: string,
		private readonly db: Database,
		private readonly dataServer: DataServer,
		private readonly networks: Networks
	) {}

	start(): void {
		const self = this;

		this.server = Bun.serve<ClientData>({
			port: API_PORT,
			hostname: 'localhost',
			fetch(req, server) {
				const upgraded = server.upgrade(req, {
					data: { subscribedEvents: new Set<string>() }
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
		});

		console.log(`[API] WebSocket server listening on ws://localhost:${API_PORT}`);
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
			client.send(JSON.stringify({ id: req.id, error: err.message }));
		}
	}

	private async execute(client: ClientSocket, method: string, params: Record<string, any>): Promise<any> {
		switch (method) {
			// Subscriptions
			case 'subscribe': {
				const events = Array.isArray(params.events) ? params.events : [params.event];
				events.forEach((e: string) => {
					client.data.subscribedEvents.add(e)
					this.fireEvent(e, client);
				});
				return true;
			}
			case 'unsubscribe': {
				const events = Array.isArray(params.events) ? params.events : [params.event];
				events.forEach((e: string) => client.data.subscribedEvents.delete(e));
				return true;
			}

			// Database
			case 'getDatasets':
				return this.db.getAllDatasets();
			case 'getDataset':
				return this.db.getDataset(params.id);

			// Networks management
			case 'networks.list':
				return this.networks.getAll();
			case 'networks.get':
				return this.networks.get(params.networkId);
			case 'networks.import': {
				const def = await this.networks.importFromFile(params.path, params.enabled ?? false);
				return def;
			}
			case 'networks.setEnabled':
				return { success: await this.networks.setEnabled(params.networkId, params.enabled) };
			case 'networks.delete':
				return { success: this.networks.delete(params.networkId) };

			// Network operations (require networkId)
			case 'connect': {
				const network = this.networks.getLiveNetwork(params.networkId);
				if (!network) throw new Error('Network not running');
				await (network as any).connectToPeer(params.multiaddr);
				return { success: true };
			}
			case 'findPeer': {
				const network = this.networks.getLiveNetwork(params.networkId);
				if (!network) throw new Error('Network not running');
				return (network as any).cliFindPeer(params.peerId);
			}
			case 'getAddresses': {
				const network = this.networks.getLiveNetwork(params.networkId);
				if (!network) throw new Error('Network not running');
				return (network as any).node?.getMultiaddrs().map((ma: any) => ma.toString()) || [];
			}
			case 'getPeers': {
				const network = this.networks.getLiveNetwork(params.networkId);
				if (!network) throw new Error('Network not running');
				return (network as any).node?.getPeers().map((p: any) => p.toString()) || [];
			}
			case 'getNodeInfo': {
				const network = this.networks.getLiveNetwork(params.networkId);
				if (!network) throw new Error('Network not running');
				const node = (network as any).node;
				return {
					peerId: node?.peerId.toString(),
					addresses: node?.getMultiaddrs().map((ma: any) => ma.toString()) || [],
				};
			}

			// Data
			case 'import': {
				const manifest = await this.dataServer.importDataset(params.path, info => {
					this.emit(client, 'import:progress', { path: params.path, ...info });
				});
				return { manifestId: manifest.id };
			}
			case 'download': {
				const network = this.networks.getLiveNetwork(params.networkId);
				if (!network) throw new Error('Network not running');
				const downloadDir = join(this.dataDir, 'downloads', Date.now().toString());
				const downloader = new Downloader(downloadDir, network, this.dataServer);
				await downloader.init(params.manifestPath);
				downloader.download()
					.then(() => this.emit(client, 'download:complete', { downloadDir }))
					.catch(err => this.emit(client, 'download:error', { error: err.message }));
				return { downloadDir };
			}
			case 'getManifest':
				return this.dataServer.getManifest(params.lishId);

			// Status
			case 'getStatus': {
				const network = this.networks.getLiveNetwork(params.networkId);
				if (!network) throw new Error('Network not running');
				const node = (network as any).node;
				const peers = node?.getPeers() || [];
				return {
					connected: peers.length,
					connectedPeers: peers.map((p: any) => p.toString()),
					peersInStore: node ? (await node.peerStore.all()).length : 0,
					datasets: this.db.getAllDatasets().length,
				};
			}

			default:
				throw new Error(`Unknown method: ${method}`);
		}
	}

	private fireEvent(event: string, client: ClientSocket): void {
		if (event === 'networks') {
			const networks = this.networks.getAll();
			this.emit(client, 'networks', networks);
		}
	}

	private broadcast(event: string, data: any): void {
		const msg = JSON.stringify({ event, data });
		for (const client of this.clients) {
			this.emit(client, event, data);
		}
	}

	private emit(client: ClientSocket, event: string, data: any): void {
		if (client.data.subscribedEvents.has(event) || client.data.subscribedEvents.has('*')) {
			client.send(JSON.stringify({ event, data }));
		}
	}
}
