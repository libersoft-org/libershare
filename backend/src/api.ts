import type { ServerWebSocket } from 'bun';
import type { Database } from './database.ts';
import type { DataServer } from './data-server.ts';
import type { Networks } from './networks.ts';
import { Downloader } from './downloader.ts';
import { join } from 'path';
import { fsInfo, fsList, fsDelete, fsMkdir, fsOpen, fsRename, fsWriteText } from './fs.ts';

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
	host?: string;
	port?: number;
	secure?: boolean;
	keyFile?: string;
	certFile?: string;
}

export class ApiServer {
	private clients: Set<ClientSocket> = new Set();
	private server: ReturnType<typeof Bun.serve<ClientData>> | null = null;
	private readonly host: string;
	private readonly port: number;
	private readonly secure: boolean;
	private readonly keyFile?: string;
	private readonly certFile?: string;

	constructor(
		private readonly dataDir: string,
		private readonly db: Database,
		private readonly dataServer: DataServer,
		private readonly networks: Networks,
		options: ApiServerOptions = {}
	) {
		this.host = options.host ?? 'localhost';
		this.port = options.port ?? 1158;
		this.secure = options.secure ?? false;
		this.keyFile = options.keyFile;
		this.certFile = options.certFile;
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
			if (!this.keyFile || !this.certFile) {
				throw new Error('--secure requires --privkey and --pubkey');
			}
			serverConfig.tls = {
				key: Bun.file(this.keyFile),
				cert: Bun.file(this.certFile),
			};
		}

		this.server = Bun.serve<ClientData>(serverConfig);

		const protocol = this.secure ? 'wss' : 'ws';
		console.log(`[API] WebSocket server listening on ${protocol}://${this.host}:${this.port}`);
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

	private async execute(client: ClientSocket, method: string, params: Record<string, any>): Promise<any> {
		console.log(`[API] Executing method: ${method}, params: ${JSON.stringify(params)}`);

		switch (method) {
			// event subscriptions
			case 'subscribe': {
				const events = Array.isArray(params.events) ? params.events : [params.event];
				events.forEach((e: string) => {
					client.data.subscribedEvents.add(e);
				});
				return true;
			}
			case 'unsubscribe': {
				const events = Array.isArray(params.events) ? params.events : [params.event];
				events.forEach((e: string) => client.data.subscribedEvents.delete(e));
				return true;
			}

			/*
			// store/query subscriptions
			case 'store.subscribe': {
					const events = Array.isArray(params.events) ? params.events : [params.event];
					events.forEach((e: string) => {
							client.data.subscribedEvents.add(e)
							this.fireEvent(e, client);
					});
					return true;
			}
			case 'store.unsubscribe': {
					const events = Array.isArray(params.events) ? params.events : [params.event];
					events.forEach((e: string) => client.data.subscribedEvents.delete(e));
					return true;
			}
			*/

			case 'getStats': {
				return {
					networks: {
						total: this.networks.getAll().length,
						enabled: this.networks.getEnabled().length,
						//connected: this.networks.getEnabled().filter(nw => nw.isConnected()).length
					},
					peers: this.networks.getEnabled().reduce((acc, nw) => {
						const liveNw = this.networks.getLiveNetwork(nw.id);
						if (liveNw && (liveNw as any).node) {
							return acc + (liveNw as any).node.getPeers().length;
						}
						return acc;
					}, 0),
					datasets: {
						total: this.db.getAllDatasets().length,
						complete: this.db.getAllDatasets().filter(ds => ds.complete).length,
						downloading: this.db.getAllDatasets().filter(ds => !ds.complete).length, // todo get actual Downloader instances here.
					},

					space: [{ path: '/', free: 1000000000, usedByDatabase: 500000000, usedByDatasets: 300000000 }],

					/*space: getDisks().forEach(disk => ({
							path: disk.mountpoint,
							free: disk.free,
							usedByDatabase: this.db.getSpaceUsedOnPath(disk.mountpoint),
							usedByDatasets: this.dataServer.getSpaceUsedOnPath(disk.mountpoint),
					})),*/
					transfers: {
						download: {
							now: 123,
							total: 456,
						},
						upload: {
							now: 123,
							total: 456,
						},
					},
				};
			}

			// Networks management
			case 'networks.list':
				return this.networks.getAll();
			case 'networks.get':
				return this.networks.get(params.networkId);
			case 'networks.importFromFile': {
				const def = await this.networks.importFromFile(params.path, params.enabled ?? false);
				return def;
			}
			case 'networks.importFromJson': {
				const def = await this.networks.importFromJson(params.json, params.enabled ?? false);
				return def;
			}

			// Network operations (require networkId)

			case 'networks.setEnabled':
				return { success: await this.networks.setEnabled(params.networkId, params.enabled) };
			case 'networks.delete':
				return { success: await this.networks.delete(params.networkId) };

			case 'networks.connect': {
				const network = this.networks.getLiveNetwork(params.networkId);
				if (!network) throw new Error('Network not running');
				await (network as any).connectToPeer(params.multiaddr);
				return { success: true };
			}
			case 'networks.findPeer': {
				const network = this.networks.getLiveNetwork(params.networkId);
				if (!network) throw new Error('Network not running');
				return (network as any).cliFindPeer(params.peerId);
			}
			case 'networks.getAddresses': {
				const network = this.networks.getLiveNetwork(params.networkId);
				if (!network) throw new Error('Network not running');
				return (network as any).node?.getMultiaddrs().map((ma: any) => ma.toString()) || [];
			}
			case 'networks.getPeers': {
				const network = this.networks.getLiveNetwork(params.networkId);
				if (!network) throw new Error('Network not running');
				return (network as any).node?.getPeers().map((p: any) => p.toString()) || [];
			}
			case 'networks.getNodeInfo': {
				const network = this.networks.getLiveNetwork(params.networkId);
				if (!network) throw new Error('Network not running');
				const node = (network as any).node;
				return {
					peerId: node?.peerId.toString(),
					addresses: node?.getMultiaddrs().map((ma: any) => ma.toString()) || [],
				};
			}
			case 'networks.getStatus': {
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
			case 'networks.infoAll': {
				const definitions = this.networks.getAll();
				const result = [];
				for (const def of definitions) {
					const info: any = {
						id: def.id,
						version: def.version,
						name: def.name,
						description: def.description,
						bootstrap_peers: def.bootstrap_peers,
						enabled: def.enabled,
					};
					if (def.enabled) {
						const network = this.networks.getLiveNetwork(def.id);
						if (network) {
							const node = (network as any).node;
							if (node) {
								const peers = node.getPeers() || [];
								info.peerId = node.peerId.toString();
								info.addresses = node.getMultiaddrs().map((ma: any) => ma.toString());
								info.connected = peers.length;
								info.connectedPeers = peers.map((p: any) => p.toString());
								info.peersInStore = (await node.peerStore.all()).length;
							}
						}
					}
					result.push(info);
				}
				return result;
			}

			// Manifests
			case 'manifests.getAllManifests':
				return this.dataServer.getAllManifests();
			case 'manifests.getManifest':
				return this.dataServer.getManifest(params.lishId);

			// Datasets
			case 'datasets.getDatasets':
				return this.db.getAllDatasets();
			case 'datasets.getDataset':
				return this.db.getDataset(params.id);

			// high-level operations

			// given a directory path, create and import a Lish manifest and a corresponding dataset
			case 'createLish': {
				console.log(JSON.stringify(params, null, 2));

				const manifest = await this.dataServer.createLish(
					params.inputPath,
					params.saveToFile,
					params.addToSharing,
					params.name,
					params.description,
					params.outputFilePath,
					params.algorithm,
					params.chunkSize,
					params.threads,

					// todo: check that path is not already in datasets.
					// todo: check that path exists
					//

					info => {
						this.emit(client, 'createLish:progress', { path: params.path, ...info });
					}
				);
				return { manifestId: manifest.id };
			}

			case 'fetchUrl': {
				if (!params.url) throw new Error('url parameter required');
				const response = await fetch(params.url);
				if (!response.ok) {
					return {
						status: response.status,
					};
				}
				const content = await response.text();
				return {
					status: response.status,
					contentType: response.headers.get('content-type'),
					content,
				};
			}

			// Filesystem operations
			case 'fs.info':
				return await fsInfo();

			case 'fs.list':
				return await fsList(params.path);

			case 'fs.delete':
				return await fsDelete(params.path);

			case 'fs.mkdir':
				return await fsMkdir(params.path);

			case 'fs.open':
				return await fsOpen(params.path);

			case 'fs.rename':
				return await fsRename(params.path, params.newName);

			case 'fs.writeText':
				await fsWriteText(params.path, params.content);
				return { success: true };

			case 'download': {
				/*
				todo:
				// replace this with setDownloadEnabled(lishId, networkId, enabled)
				//  can a dataset be associated with multiple networks, for download and for upload?
				//  split state of Downloader runtime object from the dataset state (initializing = creating directory structure, ...)
				//  re-create Downloader objects on app start /// or on network association // dissociation?
				 */

				/*
				awaiting and returning download completion here only for testing purposes.
				*/

				const network = this.networks.getLiveNetwork(params.networkId);
				if (!network) throw new Error('Network not running');
				const downloadDir = join(this.dataDir, 'downloads', Date.now().toString());
				const downloader = new Downloader(downloadDir, network, this.dataServer);
				await downloader.init(params.manifestPath);
				downloader
					.download()
					.then(() => this.emit(client, 'download:complete', { downloadDir }))
					.catch(err => this.emit(client, 'download:error', { error: err.message }));
				return { downloadDir };
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
