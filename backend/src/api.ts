import type { ServerWebSocket } from 'bun';
import type { Database } from './database.ts';
import type { DataServer } from './data-server.ts';
import type { Network } from './network.ts';
import { Downloader } from './downloader.ts';
import { join } from 'path';

const API_PORT = 1158;

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
		private readonly network: Network
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
				events.forEach((e: string) => client.data.subscribedEvents.add(e));
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

			// Network
			case 'connect':
				await (this.network as any).connectToPeer(params.multiaddr);
				return { success: true };
			case 'findPeer':
				return (this.network as any).cliFindPeer(params.peerId);
			case 'getAddresses':
				return (this.network as any).node?.getMultiaddrs().map((ma: any) => ma.toString()) || [];
			case 'getPeers':
				return (this.network as any).node?.getPeers().map((p: any) => p.toString()) || [];
			case 'getNodeInfo': {
				const node = (this.network as any).node;
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
				const downloadDir = join(this.dataDir, 'downloads', Date.now().toString());
				const downloader = new Downloader(downloadDir, this.network, this.dataServer);
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
				const node = (this.network as any).node;
				return {
					connected: node?.getPeers().length || 0,
					peersInStore: node ? (await node.peerStore.all()).length : 0,
					datasets: this.db.getAllDatasets().length,
				};
			}

			default:
				throw new Error(`Unknown method: ${method}`);
		}
	}

	private emit(client: ClientSocket, event: string, data: any): void {
		if (client.data.subscribedEvents.has(event) || client.data.subscribedEvents.has('*')) {
			client.send(JSON.stringify({ event, data }));
		}
	}

	broadcast(event: string, data: any): void {
		const msg = JSON.stringify({ event, data });
		for (const client of this.clients) {
			if (client.data.subscribedEvents.has(event) || client.data.subscribedEvents.has('*')) {
				client.send(msg);
			}
		}
	}
}
