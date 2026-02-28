import { createLibp2p } from 'libp2p';
import { KEEP_ALIVE } from '@libp2p/interface';
import { SqliteDatastore } from './datastore.ts';
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { type Libp2p } from 'libp2p';
import { type PeerId, type PrivateKey, type PeerInfo, type Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { join } from 'path';
import { DataServer } from '../lish/data-server.ts';
import { type Settings } from '../settings.ts';
import { LISH_PROTOCOL, handleLISHProtocol } from './lish-protocol.ts';
import { buildLibp2pConfig } from './network-config.ts';
import { PINK_TOPIC, PONK_TOPIC, createPinkMessage, createPonkMessage } from './pink-ponk.ts';
import { HaveMessage, WantMessage } from './downloader.ts';
import { lishTopic } from './constants.ts';
const { multiaddr: Multiaddr } = await import('@multiformats/multiaddr');
type PubSub = any; // PubSub type - using any since the exact type isn't exported from @libp2p/interface v3
/** Raw gossipsub message event. */
interface PubsubEvent {
	topic: string;
	data: Uint8Array;
}
/** Handler for parsed pubsub topic messages. */
type TopicHandler = (data: Record<string, any>) => void;
const PRIVATE_KEY_PATH = '/local/privatekey';
const AUTODIAL_WORKAROUND = true;

/**
 * Single shared libp2p node.
 * LISH networks are logical groups represented as pubsub topics on this one node.
 */
export class Network {
	private node: Libp2p | null = null;
	private pubsub: PubSub | null = null;
	private datastore: SqliteDatastore | null = null;
	private readonly dataServer: DataServer;
	private readonly dataDir: string;
	private pingInterval: NodeJS.Timeout | null = null;
	private statusInterval: NodeJS.Timeout | null = null;
	private readonly enablePink: boolean;
	private bootstrapPeerIds: Set<string> = new Set();
	private bootstrapMultiaddrs: any[] = [];

	// Topic handlers: topic -> Set of handler functions
	private topicHandlers: Map<string, Set<TopicHandler>> = new Map();

	// Peer count change callback and debounce
	private _onPeerCountChange: ((counts: { networkID: string; count: number }[]) => void) | null = null;
	private _peerCountDebounceTimer: NodeJS.Timeout | null = null;
	private _lastPeerCounts: Map<string, number> = new Map();

	private readonly settings: Settings;

	constructor(dataDir: string, dataServer: DataServer, settings: Settings, enablePink: boolean = false) {
		this.dataDir = dataDir;
		this.enablePink = enablePink;
		this.dataServer = dataServer;
		this.settings = settings;
	}

	/**
	 * Set a callback to be called when peer counts change for any subscribed topic.
	 */
	set onPeerCountChange(cb: ((counts: { networkID: string; count: number }[]) => void) | null) {
		this._onPeerCountChange = cb;
	}

	/**
	 * Schedule a debounced check of peer counts for all subscribed topics.
	 */
	private schedulePeerCountCheck(): void {
		if (this._peerCountDebounceTimer) clearTimeout(this._peerCountDebounceTimer);
		this._peerCountDebounceTimer = setTimeout(() => {
			this._peerCountDebounceTimer = null;
			this.checkPeerCounts();
		}, 500);
	}

	/**
	 * Check peer counts for all subscribed topics and fire callback if any changed.
	 */
	private checkPeerCounts(): void {
		if (!this._onPeerCountChange || !this.pubsub) return;
		const topics = this.pubsub.getTopics();
		const prefix = 'lish/';
		let changed = false;
		const counts: { networkID: string; count: number }[] = [];
		for (const topic of topics) {
			if (!topic.startsWith(prefix)) continue;
			const networkID = topic.slice(prefix.length);
			let count = 0;
			try {
				count = this.pubsub.getSubscribers(topic).length;
			} catch {}
			const prev = this._lastPeerCounts.get(networkID) ?? -1;
			if (count !== prev) changed = true;
			this._lastPeerCounts.set(networkID, count);
			counts.push({ networkID, count });
		}
		// Also detect removed topics
		const currentNetworkIDs = new Set(counts.map(c => c.networkID));
		for (const [id] of this._lastPeerCounts) {
			if (!currentNetworkIDs.has(id)) {
				this._lastPeerCounts.delete(id);
				changed = true;
			}
		}
		if (changed) this._onPeerCountChange(counts);
	}

	private async loadOrCreatePrivateKey(datastore: SqliteDatastore): Promise<PrivateKey> {
		try {
			if (await datastore.has(PRIVATE_KEY_PATH as any)) {
				const bytes = await datastore.get(PRIVATE_KEY_PATH as any);
				const privateKey = privateKeyFromProtobuf(bytes);
				console.log('✓ Loaded private key from datastore');
				return privateKey;
			}
		} catch (error) {
			console.log('Could not load private key:', error);
		}

		const privateKey = await generateKeyPair('Ed25519');
		const bytes = privateKeyToProtobuf(privateKey);
		await datastore.put(PRIVATE_KEY_PATH as any, bytes);
		console.log('✓ Saved new private key to datastore');
		return privateKey;
	}

	/**
	 * Start the single libp2p node.
	 * @param bootstrapPeers - merged list of bootstrap peers from all enabled lishnets
	 */
	async start(bootstrapPeers: string[] = []): Promise<void> {
		if (this.node) {
			console.log('Network node is already running');
			return;
		}

		// Read settings
		const allSettings = this.settings.list();

		// Initialize datastore (single shared datastore)
		const datastorePath = join(this.dataDir, 'datastore');
		this.datastore = new SqliteDatastore(datastorePath);
		this.datastore.open();
		console.log('✓ Datastore opened at:', datastorePath);

		const privateKey = await this.loadOrCreatePrivateKey(this.datastore);

		// Build libp2p config via extracted helper
		const { config, port, bootstrapPeerIds, bootstrapMultiaddrs } = buildLibp2pConfig({
			privateKey,
			datastore: this.datastore,
			allSettings,
			bootstrapPeers,
			myPeerId: privateKey.publicKey.toString(),
		});
		this.bootstrapPeerIds = bootstrapPeerIds;
		this.bootstrapMultiaddrs = bootstrapMultiaddrs;

		console.log('Creating libp2p node...');
		try {
			this.node = await createLibp2p(config);
		} catch (err: any) {
			if (err?.name === 'UnsupportedListenAddressesError' || err?.code === 'ERR_NO_VALID_ADDRESSES') {
				console.error(`✗ Failed to start network: port ${port} is likely already in use or the listen address is invalid.`);
				console.error(`  Try changing the port in settings or stop the other process using port ${port}.`);
				throw err;
			}
			throw err;
		}
		console.log('Port:', port);
		console.log('Node ID:', this.node.peerId.toString());

		try {
			await this.node.start();
		} catch (err: any) {
			if (err?.name === 'UnsupportedListenAddressesError' || err?.code === 'ERR_NO_VALID_ADDRESSES') {
				console.error(`✗ Failed to start network: port ${port} is likely already in use or the listen address is invalid.`);
				console.error(`  Try changing the port in settings or stop the other process using port ${port}.`);
			}
			throw err;
		}
		console.log('Node started');

		const addresses = this.node.getMultiaddrs();
		console.log('Listening on addresses:');
		addresses.forEach(addr => console.log('  -', addr.toString()));

		this.pubsub = this.node.services.pubsub as PubSub;

		// Register lish protocol handler
		await this.node.handle(
			LISH_PROTOCOL,
			async stream => {
				await handleLISHProtocol(stream, this.dataServer);
			},
			{ runOnLimitedConnection: true }
		);
		console.log(`✓ Registered ${LISH_PROTOCOL} protocol handler`);

		const dht = this.node.services.dht as any;
		if (dht) {
			const mode = dht.clientMode === false ? 'server' : 'client';
			console.log('✓ DHT running in', mode, 'mode');
		}

		this.pubsub.addEventListener('gossipsub:graft', evt => {
			console.log('🌿 GRAFT:', evt.detail.peerID, 'joined', evt.detail.topic);
			this.schedulePeerCountCheck();
		});

		this.pubsub.addEventListener('gossipsub:prune', evt => {
			console.log('✂️  PRUNE:', evt.detail.peerID, 'left', evt.detail.topic);
			this.schedulePeerCountCheck();
		});

		console.log('Peers in store:', this.node.getPeers().length);
		console.log('Services loaded:', Object.keys(this.node.services));

		this.setupEventListeners();
		this.setupPinkPonk();
		this.setupPubsubDispatch();
		this.setupBootstrapWorkaround();
		this.setupStatusInterval();
	}

	// =========================================================================
	// Event listeners setup (extracted from start() for readability)
	// =========================================================================

	private setupEventListeners(): void {
		this.node!.addEventListener('peer:discovery', async evt => {
			const peerID = evt.detail.id.toString();
			const multiaddrs = evt.detail.multiaddrs?.map((ma: any) => ma.toString()) || [];
			console.log('🔍 Discovered peer:', peerID);
			console.log('   Multiaddrs:', multiaddrs.join(', ') || '(empty!)');
		});

		this.node!.addEventListener('peer:connect', async evt => {
			const peerID = evt.detail.toString();
			const connections = this.node!.getConnections(evt.detail);
			const remoteAddrs = connections.map(c => c.remoteAddr.toString());
			console.log('✅ New peer connected:', peerID);
			console.log('   Remote addresses:', remoteAddrs.join(', '));
			console.log('   Total connected peers:', this.node!.getPeers().length);

			if (this.bootstrapPeerIds.has(peerID)) {
				const connectionMultiaddrs = connections.map(c => c.remoteAddr);
				await this.node!.peerStore.merge(evt.detail, {
					multiaddrs: connectionMultiaddrs,
					tags: { [KEEP_ALIVE]: { value: 1 } },
				});
				console.log('   Tagged as KEEP_ALIVE (bootstrap peer)');
			}
			this.schedulePeerCountCheck();
		});

		this.node!.addEventListener('peer:disconnect', evt => {
			console.log('❌ Lost connection with peer:', evt.detail.toString());
			console.log('   Total connected peers:', this.node!.getPeers().length);
			this.schedulePeerCountCheck();
		});

		this.node!.addEventListener('relay:created-reservation' as any, (evt: any) => {
			console.log('🔄 Relay reservation created with:', evt.detail.relay.toString());
		});
		this.node!.addEventListener('relay:removed' as any, (evt: any) => {
			console.log('⚠️  Relay removed:', evt.detail.relay.toString());
		});
	}

	private setupPinkPonk(): void {
		if (!this.enablePink) return;
		this.pubsub!.subscribe(PINK_TOPIC);
		this.pubsub!.subscribe(PONK_TOPIC);
		console.log('✓ Subscribed to pink/ponk topics');
		this.pingInterval = setInterval(async () => {
			await this.sendPink();
		}, 10000);
	}

	private setupPubsubDispatch(): void {
		this.pubsub!.addEventListener('message', evt => {
			this.handleMessage(evt.detail);
		});
	}

	private setupBootstrapWorkaround(): void {
		if (!AUTODIAL_WORKAROUND || this.bootstrapMultiaddrs.length === 0) return;
		setTimeout(async () => {
			if (this.node!.getPeers().length === 0) {
				console.log('⚠️  Bootstrap module failed - dialing directly...');
				for (const ma of this.bootstrapMultiaddrs) {
					try {
						await this.node!.dial(ma);
						console.log('✓ Connected to bootstrap peer via direct dial');
						break;
					} catch (err: any) {
						console.log('✗ Direct dial failed:', err.message);
					}
				}
			}
		}, 2000);
	}

	private setupStatusInterval(): void {
		this.statusInterval = setInterval(async () => {
			const connectedPeers = this.node!.getPeers();
			const allPeers = await this.node!.peerStore.all();
			console.log(`📊 Status: ${connectedPeers.length} connected, ${allPeers.length} in peer store, topics: ${this.pubsub!.getTopics().join(', ')}`);
			if (AUTODIAL_WORKAROUND && connectedPeers.length === 0 && this.bootstrapMultiaddrs.length > 0) {
				console.log('   ⚠️  No connections - dialing bootstrap peers directly...');
				for (const ma of this.bootstrapMultiaddrs) {
					try {
						await this.node!.dial(ma);
						console.log(`   ✓ Connected`);
						break;
					} catch (err: any) {
						console.log(`   ✗ Failed: ${err.message}`);
					}
				}
			}
		}, 10000);
	}

	// =========================================================================
	// Runtime state
	// =========================================================================

	/**
	 * Whether the node is running.
	 */
	isRunning(): boolean {
		return this.node !== null;
	}

	/**
	 * Add bootstrap peers dynamically to the running node.
	 * Dials them directly since the bootstrap module only works at config time.
	 */
	async addBootstrapPeers(peers: string[]): Promise<void> {
		if (!this.node) {
			console.error('Network not started - cannot add bootstrap peers');
			return;
		}
		const myPeerId = this.node.peerId.toString();
		for (const peer of peers) {
			// Skip our own address or already-known bootstrap peers
			if (peer.includes(myPeerId)) continue;
			try {
				const ma = Multiaddr(peer);
				const peerID = ma.getPeerId();
				if (peerID && this.bootstrapPeerIds.has(peerID)) continue;
				if (peerID) {
					this.bootstrapPeerIds.add(peerID);
					this.bootstrapMultiaddrs.push(ma);
				}
				console.log('Adding bootstrap peer:', peer);
				try {
					await this.node.dial(ma);
					if (peerID) {
						await this.node.peerStore.merge(peerIdFromString(peerID), {
							multiaddrs: [ma],
							tags: { [KEEP_ALIVE]: { value: 1 } },
						});
					}
					console.log('✓ Connected to new bootstrap peer');
				} catch (err: any) {
					console.log('⚠️  Could not connect to bootstrap peer:', err.message);
				}
			} catch (error: any) {
				console.log('⚠️  Skipping invalid multiaddr:', peer, '-', error.message);
			}
		}
	}

	// =========================================================================
	// Topic (lishnet) management
	// =========================================================================

	/**
	 * Subscribe to a lishnet topic. The node will receive pubsub messages for this network.
	 */
	subscribeTopic(networkID: string): void {
		if (!this.pubsub) {
			console.error('Network not started - cannot subscribe to topic');
			return;
		}
		const topic = lishTopic(networkID);
		this.pubsub.subscribe(topic);
		// Register the Want handler for this network
		const handler: TopicHandler = data => {
			console.log(`Received pubsub message on topic ${topic}:`, data.type);
			if (data.type === 'want') this.handleWant(data as WantMessage, networkID);
		};
		if (!this.topicHandlers.has(topic)) this.topicHandlers.set(topic, new Set());
		this.topicHandlers.get(topic)!.add(handler);
		console.log(`✓ Subscribed to lishnet topic: ${topic}`);
	}

	/**
	 * Unsubscribe from a lishnet topic.
	 */
	unsubscribeTopic(networkID: string): void {
		if (!this.pubsub) return;
		const topic = lishTopic(networkID);
		this.pubsub.unsubscribe(topic);
		this.topicHandlers.delete(topic);
		console.log(`✓ Unsubscribed from lishnet topic: ${topic}`);
	}

	/**
	 * Get peers subscribed to a specific lishnet topic.
	 */
	getTopicPeers(networkID: string): string[] {
		if (!this.pubsub) return [];
		const topic = lishTopic(networkID);
		try {
			return this.pubsub.getSubscribers(topic).map((p: any) => p.toString());
		} catch {
			return [];
		}
	}

	// =========================================================================
	// Pink/Ponk (debug)
	// =========================================================================

	private handleMessage(msgEvent: PubsubEvent): void {
		try {
			const topic = msgEvent.topic;
			const data = new TextDecoder().decode(msgEvent.data);
			const message = JSON.parse(data);

			// Dispatch to pink handler
			if (topic === PINK_TOPIC) {
				this.sendPonk(message.peerID);
				return;
			}

			// Dispatch to registered topic handlers
			const handlers = this.topicHandlers.get(topic);
			if (handlers) {
				for (const handler of handlers) {
					handler(message);
				}
			}
		} catch (error) {
			console.error('Error in handleMessage:', error);
		}
	}

	public async sendPink(): Promise<void> {
		if (!this.pubsub || !this.node) return;
		const message = createPinkMessage(this.node.peerId.toString());
		const data = new TextEncoder().encode(JSON.stringify(message));
		try {
			await this.pubsub.publish(PINK_TOPIC, data);
		} catch (error) {
			console.log('Error sending pink:', error);
		}
	}

	private async sendPonk(inReplyTo: string): Promise<void> {
		if (!this.pubsub || !this.node) return;
		const message = createPonkMessage(this.node.peerId.toString(), inReplyTo);
		const data = new TextEncoder().encode(JSON.stringify(message));
		try {
			await this.pubsub.publish(PONK_TOPIC, data);
		} catch (error) {
			console.log(`Ponk reply attempted (no peers connected)`);
		}
	}

	// =========================================================================
	// Want/Have protocol (LISH data exchange)
	// =========================================================================

	private async handleWant(data: WantMessage, networkID: string): Promise<void> {
		console.log('Handling want message for lishID:', data.lishID, 'on network:', networkID);
		const lish = this.dataServer.get(data.lishID);
		if (!lish) return;
		const haveChunks = this.dataServer.getHaveChunks(lish);
		if (haveChunks !== 'all' && haveChunks.size === 0) {
			console.log('No chunks available for lishID:', data.lishID);
			return;
		}
		console.log('LISH found, sending Have');
		const haveMessage: HaveMessage = {
			type: 'have',
			lishID: lish.id,
			chunks: haveChunks === 'all' ? 'all' : Array.from(haveChunks),
			multiaddrs: this.node!.getMultiaddrs(),
			peerID: this.node!.peerId.toString(),
		};
		await this.broadcast(lishTopic(networkID), haveMessage);
	}

	// =========================================================================
	// Public API
	// =========================================================================

	async broadcast(topic: string, data: Record<string, any>): Promise<void> {
		if (!this.pubsub || !this.node) {
			console.error('Network not started');
			return;
		}
		console.log(`Broadcasting to topic ${topic}:`, data.type);
		const encoded = new TextEncoder().encode(JSON.stringify(data));
		await this.pubsub.publish(topic, encoded);
	}

	/**
	 * Subscribe to a raw pubsub topic with a handler (used by Downloader etc.)
	 */
	async subscribe(topic: string, handler: TopicHandler): Promise<void> {
		if (!this.pubsub) {
			console.error('Network not started');
			return;
		}
		this.pubsub.subscribe(topic);
		if (!this.topicHandlers.has(topic)) this.topicHandlers.set(topic, new Set());
		this.topicHandlers.get(topic)!.add(handler);
		console.log(`Subscribed to topic: ${topic}`);
	}

	async connectToPeer(multiaddr: string): Promise<void> {
		if (!this.node) throw new Error('Network not started');
		const ma = Multiaddr(multiaddr);
		await this.node.dial(ma);
		console.log('→ Connected to:', multiaddr);
	}

	async dialProtocol(peerID: string, multiaddrs: any[], protocol: string): Promise<Stream> {
		if (!this.node) throw new Error('Network not started');
		const connection = await this.node.dial(multiaddrs);
		const stream = await connection.newStream(protocol, { runOnLimitedConnection: true });
		return stream;
	}

	/**
	 * Get node info (peerID, addresses).
	 */
	getNodeInfo(): { peerID: string; addresses: string[] } | null {
		if (!this.node) return null;
		return {
			peerID: this.node.peerId.toString(),
			addresses: this.node.getMultiaddrs().map((ma: any) => ma.toString()),
		};
	}

	/**
	 * Get all connected peers (global).
	 */
	getPeers(): string[] {
		if (!this.node) return [];
		return this.node.getPeers().map((p: any) => p.toString());
	}

	/**
	 * Get topic peers with connection type info (direct vs relay).
	 */
	getTopicPeersInfo(networkID: string): { peerID: string; direct: number; relay: number }[] {
		if (!this.pubsub || !this.node) return [];
		const topic = lishTopic(networkID);
		try {
			const subscribers = this.pubsub.getSubscribers(topic);
			return subscribers.map((p: any) => {
				const connections = this.node!.getConnections(p);
				let direct = 0;
				let relay = 0;
				for (const conn of connections) {
					if (conn.remoteAddr.toString().includes('/p2p-circuit/')) relay++;
					else direct++;
				}
				return { peerID: p.toString(), direct, relay };
			});
		} catch {
			return [];
		}
	}

	async stop(): Promise<void> {
		if (this.pingInterval) {
			clearInterval(this.pingInterval);
			this.pingInterval = null;
		}
		if (this.statusInterval) {
			clearInterval(this.statusInterval);
			this.statusInterval = null;
		}
		this.topicHandlers.clear();
		if (this.node) {
			await this.node.stop();
			console.log('Network stopped');
		}
		if (this.datastore) {
			await this.datastore.close();
			console.log('Datastore closed');
		}
		this.node = null;
		this.pubsub = null;
		this.datastore = null;
	}

	async cliFindPeer(peerID: string) {
		const id = peerIdFromString(peerID);
		await this.findPeer(id);
	}

	async findPeer(peerID: PeerId): Promise<void> {
		console.log('Finding peer:');
		console.log('Closest peers:');
		for await (const peer of this.node.peerRouting.getClosestPeers(peerID.toMultihash().bytes)) {
			console.log(peer.id, peer.multiaddrs);
		}
		const peer: PeerInfo = await this.node.peerRouting.findPeer(peerID);
		console.log('Found it, multiaddrs are:');
		peer.multiaddrs.forEach(ma => console.log(ma.toString()));
	}
}
