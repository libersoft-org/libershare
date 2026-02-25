import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise, pureJsCrypto } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify, identifyPush } from '@libp2p/identify';
import { bootstrap } from '@libp2p/bootstrap';
import { kadDHT } from '@libp2p/kad-dht';
import { ping } from '@libp2p/ping';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { autoNAT } from '@libp2p/autonat';
import { KEEP_ALIVE } from '@libp2p/interface';
import { SqliteDatastore } from './datastore.ts';
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { type Libp2p } from 'libp2p';
import { type PeerId, type PrivateKey, type PeerInfo } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { join } from 'path';
import { networkInterfaces } from 'os';
import { DataServer } from '../lish/data-server.ts';
import { Settings } from '../settings.ts';
import { LISH_PROTOCOL, handleLishProtocol } from './lish-protocol.ts';
const { multiaddr: Multiaddr } = await import('@multiformats/multiaddr');
import { HaveMessage, WantMessage } from './downloader.ts';

// PubSub type - using any since the exact type isn't exported from @libp2p/interface v3
type PubSub = any;
interface PinkMessage {
	type: 'pink';
	peerID: string;
	timestamp: number;
}
interface PonkMessage {
	type: 'ponk';
	peerID: string;
	timestamp: number;
	inReplyTo: string;
}
const PINK_TOPIC = 'pink';
const PONK_TOPIC = 'ponk';
const PRIVATE_KEY_PATH = '/local/privatekey';
const AUTODIAL_WORKAROUND = true;

/**
 * Returns the pubsub topic name for a given lishnet/network ID.
 */
export function lishTopic(networkID: string): string {
	return `lish/${networkID}`;
}

/**
 * Single shared libp2p node.
 * Lishnets are logical groups represented as pubsub topics on this one node.
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
	private topicHandlers: Map<string, Set<(data: any) => void>> = new Map();

	// Peer count change callback and debounce
	private _onPeerCountChange: ((counts: { networkID: string; count: number }[]) => void) | null = null;
	private _peerCountDebounceTimer: NodeJS.Timeout | null = null;
	private _lastPeerCounts: Map<string, number> = new Map();

	constructor(dataDir: string, dataServer: DataServer, enablePink: boolean = false) {
		this.dataDir = dataDir;
		this.enablePink = enablePink;
		this.dataServer = dataServer;
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
	async start(bootstrapPeers: string[] = []) {
		if (this.node) {
			console.log('Network node is already running');
			return;
		}

		// Load settings
		const settings = new Settings(this.dataDir);
		const allSettings = settings.getAll();
		// Initialize datastore (single shared datastore)
		const datastorePath = join(this.dataDir, 'datastore');
		this.datastore = new SqliteDatastore(datastorePath);
		this.datastore.open();
		console.log('✓ Datastore opened at:', datastorePath);
		const privateKey = await this.loadOrCreatePrivateKey(this.datastore);
		// Build transports array
		const transports: any[] = [tcp()];
		transports.push(circuitRelayTransport());
		console.log(`✓ Circuit relay client enabled`);

		// Build listen addresses
		const port = allSettings.network?.incomingPort || 0;
		const listenAddresses = [`/ip4/0.0.0.0/tcp/${port}`];

		const maxRelays = 10;
		for (let i = 0; i < maxRelays; i++) {
			listenAddresses.push('/p2p-circuit');
		}
		console.log(`✓ Configured to reserve ${maxRelays} relay slots`);

		// Build appendAnnounce addresses.
		// libp2p detects all network interfaces when listening on 0.0.0.0,
		// but marks public transport addresses as unverified (requires AutoNAT confirmation).
		// appendAnnounce addresses are always marked as verified, so they appear immediately.
		// We auto-detect non-internal IPv4 interfaces and add them here.
		const appendAnnounceAddresses: string[] = [];
		const ifaces = networkInterfaces();
		for (const [name, addrs] of Object.entries(ifaces)) {
			if (!addrs) continue;
			for (const addr of addrs) {
				if (addr.family === 'IPv4' && !addr.internal) {
					appendAnnounceAddresses.push(`/ip4/${addr.address}/tcp/${port}`);
					console.log(`✓ Announce address (auto-detected, ${name}): /ip4/${addr.address}/tcp/${port}`);
				}
			}
		}
		// Add user-configured announce addresses
		if (allSettings.network?.announceAddresses?.length) {
			for (const addr of allSettings.network.announceAddresses) {
				appendAnnounceAddresses.push(addr);
				console.log(`✓ Announce address (configured): ${addr}`);
			}
		}

		const config: any = {
			privateKey,
			datastore: this.datastore,
			addresses: {
				listen: listenAddresses,
				appendAnnounce: appendAnnounceAddresses.length > 0 ? appendAnnounceAddresses : undefined,
			},
			transports,
			connectionEncrypters: [noise({ crypto: pureJsCrypto })],
			streamMuxers: [yamux()],
			connectionManager: {
				minConnections: 1,
				maxConnections: 100,
				autoDial: true,
				autoDialInterval: 1000,
			},
			// No connectionProtector - swarm key removed. Open network, isolation via topics.
			peerStore: {
				persistence: true,
				threshold: 15,
			},
			services: {
				identify: identify(),
				identifyPush: identifyPush(),
				ping: ping(),
				pubsub: gossipsub({
					emitSelf: false,
					allowPublishToZeroTopicPeers: true,
					floodPublish: true,
					D: 2,
					Dlo: 1,
					Dhi: 3,
					Dlazy: 2,
					heartbeatInterval: 1000,
					fanoutTTL: 60000,
				}),
				dht: kadDHT({
					clientMode: false,
					initialQuerySelfInterval: 3600000,
					querySelfInterval: 3600000,
				}),
			},
		};

		// Add relay server service if enabled
		if (allSettings.network?.allowRelay) {
			const maxReservationsRaw = allSettings.network?.maxRelayReservations ?? 0;
			const maxReservations = maxReservationsRaw === 0 ? Infinity : maxReservationsRaw;
			config.services.relay = circuitRelayServer({
				reservations: { maxReservations },
			});
			console.log(`✓ Circuit relay server enabled (maxReservations: ${maxReservationsRaw === 0 ? 'unlimited' : maxReservationsRaw})`);
		}

		// Add autonat service
		config.services.autonat = autoNAT();
		console.log('✓ AutoNAT enabled');

		// Deduplicate bootstrap peers and filter out our own peer ID
		const myPeerId = privateKey.publicKey.toString();
		const uniqueBootstrapPeers = [...new Set(bootstrapPeers)].filter(p => !p.includes(myPeerId));

		if (uniqueBootstrapPeers.length > 0) {
			console.log('Configuring bootstrap peers:');
			const validBootstrapPeers: string[] = [];

			for (const peer of uniqueBootstrapPeers) {
				console.log('  -', peer);
				try {
					const ma = Multiaddr(peer);
					const peerID = ma.getPeerId();
					if (peerID) {
						this.bootstrapPeerIds.add(peerID);
						this.bootstrapMultiaddrs.push(ma);
					}
					validBootstrapPeers.push(peer);
				} catch (error: any) {
					console.log('  ⚠️  Skipping invalid multiaddr:', peer, '-', error.message);
				}
			}

			if (validBootstrapPeers.length > 0) {
				config.peerDiscovery = [
					bootstrap({
						list: validBootstrapPeers,
						timeout: 1000,
						tagTTL: 2147483647,
						tagValue: 100,
					}),
				];
			}
		} else {
			console.log('No bootstrap peers configured. Node will start in standalone mode.');
		}

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
				await handleLishProtocol(stream, this.dataServer);
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

		// Listen for peer events
		this.node.addEventListener('peer:discovery', async evt => {
			const peerID = evt.detail.id.toString();
			const multiaddrs = evt.detail.multiaddrs?.map((ma: any) => ma.toString()) || [];
			console.log('🔍 Discovered peer:', peerID);
			console.log('   Multiaddrs:', multiaddrs.join(', ') || '(empty!)');
		});

		this.node.addEventListener('peer:connect', async evt => {
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

		this.node.addEventListener('peer:disconnect', evt => {
			console.log('❌ Lost connection with peer:', evt.detail.toString());
			console.log('   Total connected peers:', this.node!.getPeers().length);
			this.schedulePeerCountCheck();
		});

		// Relay events
		this.node.addEventListener('relay:created-reservation' as any, (evt: any) => {
			console.log('🔄 Relay reservation created with:', evt.detail.relay.toString());
		});
		this.node.addEventListener('relay:removed' as any, (evt: any) => {
			console.log('⚠️  Relay removed:', evt.detail.relay.toString());
		});

		if (this.enablePink) {
			this.pubsub.subscribe(PINK_TOPIC);
			this.pubsub.subscribe(PONK_TOPIC);
			console.log('✓ Subscribed to pink/ponk topics');
			this.pingInterval = setInterval(async () => {
				await this.sendPink();
			}, 10000);
		}

		// Handle incoming pubsub messages - dispatch to per-topic handlers
		this.pubsub.addEventListener('message', evt => {
			this.handleMessage(evt.detail);
		});

		// Immediate bootstrap dial workaround
		if (AUTODIAL_WORKAROUND && this.bootstrapMultiaddrs.length > 0) {
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

		// Periodic status log
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
	subscribeTopic(networkID: string) {
		if (!this.pubsub) {
			console.error('Network not started - cannot subscribe to topic');
			return;
		}
		const topic = lishTopic(networkID);
		this.pubsub.subscribe(topic);
		// Register the Want handler for this network
		const handler = (data: any) => {
			console.log(`Received pubsub message on topic ${topic}:`, data.type);
			if (data.type === 'want') this.handleWant(data, networkID);
		};
		if (!this.topicHandlers.has(topic)) this.topicHandlers.set(topic, new Set());
		this.topicHandlers.get(topic)!.add(handler);
		console.log(`✓ Subscribed to lishnet topic: ${topic}`);
	}

	/**
	 * Unsubscribe from a lishnet topic.
	 */
	unsubscribeTopic(networkID: string) {
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

	/**
	 * Get all topics this node is subscribed to.
	 */
	getSubscribedTopics(): string[] {
		if (!this.pubsub) return [];
		return this.pubsub.getTopics();
	}

	// =========================================================================
	// Pink/Ponk (debug)
	// =========================================================================

	private handleMessage(msgEvent: any) {
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

	public async sendPink() {
		if (!this.pubsub || !this.node) return;
		const message: PinkMessage = {
			type: 'pink',
			peerID: this.node.peerId.toString(),
			timestamp: Date.now(),
		};
		const data = new TextEncoder().encode(JSON.stringify(message));
		try {
			await this.pubsub.publish(PINK_TOPIC, data);
		} catch (error) {
			console.log('Error sending pink:', error);
		}
	}

	private async sendPonk(inReplyTo: string) {
		if (!this.pubsub || !this.node) return;
		const message: PonkMessage = {
			type: 'ponk',
			peerID: this.node.peerId.toString(),
			timestamp: Date.now(),
			inReplyTo,
		};
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

	private async handleWant(data: WantMessage, networkID: string) {
		console.log('Handling want message for lishID:', data.lishID, 'on network:', networkID);
		let lish = await this.dataServer.getLish(data.lishID);
		if (!lish) return;
		let haveChunks = await this.dataServer.getHaveChunks(lish);
		if (this.dataDir === '../../data1') haveChunks = 'all'; // mock
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

	async broadcast(topic: string, data: any) {
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
	async subscribe(topic: string, handler: (data: any) => void) {
		if (!this.pubsub) {
			console.error('Network not started');
			return;
		}
		this.pubsub.subscribe(topic);
		if (!this.topicHandlers.has(topic)) this.topicHandlers.set(topic, new Set());
		this.topicHandlers.get(topic)!.add(handler);
		console.log(`Subscribed to topic: ${topic}`);
	}

	async connectToPeer(multiaddr: string) {
		if (!this.node) throw new Error('Network not started');
		const ma = Multiaddr(multiaddr);
		await this.node.dial(ma);
		console.log('→ Connected to:', multiaddr);
	}

	public printMultiaddrs() {
		if (!this.node) {
			console.log('Network not started');
			return;
		}
		const addrs = this.node.getMultiaddrs();
		console.log('Current multiaddrs:');
		addrs.forEach(addr => {
			let emoji = '?';
			const protos = addr.protos();
			if (protos.some(p => p.name === 'p2p-circuit')) {
				emoji = '🔄';
			} else {
				try {
					const nodeAddr = addr.nodeAddress();
					if (nodeAddr.address === '127.0.0.1' || nodeAddr.address === '::1') emoji = '🏠';
					else if (nodeAddr.family === 4) {
						const octets = nodeAddr.address.split('.').map(Number);
						if (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168)) emoji = '🏢';
						else emoji = '🌍';
					} else if (nodeAddr.family === 6) {
						if (nodeAddr.address.startsWith('fe80:') || nodeAddr.address.startsWith('fc')) emoji = '🏢';
						else emoji = '🌍';
					}
				} catch (e) {}
			}
			console.log(`${emoji} ${addr.toString()}`);
		});
	}

	async dialProtocol(peerID: string, multiaddrs: any[], protocol: string) {
		if (!this.node) throw new Error('Network not started');
		const connection = await this.node.dial(multiaddrs);
		const stream = await connection.newStream(protocol, { runOnLimitedConnection: true });
		return stream;
	}

	/**
	 * Get node info (peerID, addresses).
	 */
	getNodeInfo() {
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

	async stop() {
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

	async findPeer(peerID: PeerId) {
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
