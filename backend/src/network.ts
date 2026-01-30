import { createLibp2p } from 'libp2p';
import { Utils } from './utils.ts';
import { preSharedKey } from '@libp2p/pnet';
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
import { enable as enableLibp2pLogs } from '@libp2p/logger';
import { KEEP_ALIVE } from '@libp2p/interface';
import { LevelDatastore } from 'datastore-level';
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import type { Libp2p } from 'libp2p';
import type { Peer, PeerId, PrivateKey, PeerInfo } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DataServer } from './data-server.ts';
import { LISH_PROTOCOL, handleLishProtocol } from './lish-protocol.ts';
const { multiaddr: Multiaddr } = await import('@multiformats/multiaddr');
import { HaveMessage, LISH_TOPIC, WantMessage } from './downloader.ts';
import type { NetworkDefinition } from './networks.ts';
// PubSub type - using any since the exact type isn't exported from @libp2p/interface v3
type PubSub = any;
interface PinkMessage {
	type: 'pink';
	peerId: string;
	timestamp: number;
}
interface PonkMessage {
	type: 'ponk';
	peerId: string;
	timestamp: number;
	inReplyTo: string;
}
const PINK_TOPIC = 'pink';
const PONK_TOPIC = 'ponk';
const PRIVATE_KEY_PATH = '/local/privatekey';
const AUTODIAL_WORKAROUND = true; // Enable manual dialing when autoDial fails
type Message = PinkMessage | PonkMessage;

export class Network {
	private node: Libp2p | null = null;
	private pubsub: PubSub | null = null;
	private datastore: LevelDatastore | null = null;
	private readonly dataServer: DataServer;
	private readonly dataDir: string;
	private pingInterval: NodeJS.Timeout | null = null;
	private addressInterval: NodeJS.Timeout | null = null;
	private statusInterval: NodeJS.Timeout | null = null;
	private readonly enablePink: boolean;
	private bootstrapPeerIds: Set<string> = new Set();
	private bootstrapMultiaddrs: any[] = []; // Store full multiaddrs for direct dialing
	private readonly networkDef: NetworkDefinition | null;

	constructor(dataDir: string, dataServer: DataServer, enablePink: boolean = false, networkDef: NetworkDefinition | null = null) {
		this.dataDir = dataDir;
		this.enablePink = enablePink;
		this.dataServer = dataServer;
		this.networkDef = networkDef;
	}

	private async loadOrCreatePrivateKey(datastore: LevelDatastore): Promise<PrivateKey> {
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

	async start() {
		if (!this.networkDef) throw new Error('NetworkDefinition is required to start a network');
		// Load settings from dataDir
		const settingsPath = join(this.dataDir, 'settings.json');
		const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
		console.log(`Decoding swarm key from base62...`);
		const swarmKey = Utils.decodeBase62(this.networkDef.key);
		const bootstrapPeers = this.networkDef.bootstrap_peers;
		// Initialize datastore (network-specific path)
		const datastorePath = join(this.dataDir, `datastore-${this.networkDef.id}`);
		this.datastore = new LevelDatastore(datastorePath);
		await this.datastore.open();
		console.log('✓ Datastore opened at:', datastorePath);
		const privateKey = await this.loadOrCreatePrivateKey(this.datastore);
		// Build transports array
		const transports: any[] = [tcp()];
		// Add circuit relay transport if client mode is enabled
		const relayClientMode = settings.relay?.client?.mode || 'force';
		const relayClientEnabled = relayClientMode === 'force' || relayClientMode === 'auto';
		if (relayClientEnabled) {
			transports.push(circuitRelayTransport());
			console.log(`✓ Circuit relay client enabled (mode: ${relayClientMode})`);
		}

		// Build listen addresses (use port 0 to let OS assign if not specified)
		const port = settings.network?.port || 0;
		const listenAddresses = [`/ip4/0.0.0.0/tcp/${port}`];
		if (relayClientEnabled) {
			// Add /p2p-circuit entries - one per desired relay reservation
			const maxRelays = settings.relay?.client?.maxRelays || 2;
			for (let i = 0; i < maxRelays; i++) {
				listenAddresses.push('/p2p-circuit');
			}
			console.log(`✓ Configured to reserve ${maxRelays} relay slots`);
		}

		const config: any = {
			privateKey,
			datastore: this.datastore,
			addresses: {
				listen: listenAddresses,
			},
			transports,
			connectionEncrypters: [noise({ crypto: pureJsCrypto })],
			streamMuxers: [yamux()],
			connectionManager: {
				minConnections: 1, // Auto-dial to maintain at least 1 connection
				maxConnections: 100,
				autoDial: true,
				autoDialInterval: 1000,
			},
			connectionProtector: preSharedKey({
				psk: swarmKey,
			}),
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
					floodPublish: true, // Send to all peers, not just mesh (for small networks)
					D: 2, // Optimal degree for small networks (2-3 nodes)
					Dlo: 1, // Minimum mesh size
					Dhi: 3, // Maximum mesh size
					Dlazy: 2, // Lazy peers (for gossip)
					heartbeatInterval: 1000, // Check mesh every second (default is 1000ms)
					fanoutTTL: 60000,
				}),
				dht: kadDHT({
					clientMode: false,
					// Reduce DHT random walk spam in small networks
					// These control how often the node queries itself to maintain routing table
					initialQuerySelfInterval: 3600000, // 1 hour (default: 1000ms)
					querySelfInterval: 3600000, // 1 hour (default: 10000ms)
				}),
			},
		};

		// Add relay server service if enabled
		if (settings.relay?.server?.enabled) {
			const maxReservations = settings.relay.server.maxReservations || 15;
			config.services.relay = circuitRelayServer({
				reservations: {
					maxReservations,
				},
			});
			console.log(`✓ Circuit relay server enabled (maxReservations: ${maxReservations})`);
		}

		// Add autonat service if client mode is 'auto'
		if (relayClientMode === 'auto') {
			config.services.autonat = autoNAT();
			console.log('✓ AutoNAT enabled');
		}

		// Add bootstrap if peers are configured
		if (bootstrapPeers.length > 0) {
			console.log('Configuring bootstrap peers:');
			for (const peer of bootstrapPeers) {
				console.log('  -', peer);
				// Extract peer ID and store full multiaddr for direct dialing
				const ma = Multiaddr(peer);
				const peerId = ma.getPeerId();
				if (peerId) {
					this.bootstrapPeerIds.add(peerId);
					this.bootstrapMultiaddrs.push(ma);
				}
			}
			config.peerDiscovery = [
				bootstrap({
					list: bootstrapPeers,
					timeout: 1000,
					tagTTL: 2147483647, // ~68 years in ms - effectively never expires
					tagValue: 100, // High priority (default 50) - pruned last
				}),
			];
		} else {
			console.log('⚠️  No bootstrap peers configured!');
			console.log('   Add bootstrap peers.');
			console.log('   Format: /ip4/<IP>/tcp/<PORT>/p2p/<PEER_ID>');
		}
		console.log('Creating libp2p node with config:');
		console.log('  peerDiscovery configured:', !!config.peerDiscovery);
		if (config.peerDiscovery) console.log('  peerDiscovery modules:', config.peerDiscovery.length);
		this.node = await createLibp2p(config);
		console.log('Port:', settings.network.port);
		console.log('Node ID:', this.node.peerId.toString());
		await this.node.start();
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
			// runOnLimitedConnection allows handling streams on relay/limited connections
			{ runOnLimitedConnection: true }
		);
		console.log(`✓ Registered ${LISH_PROTOCOL} protocol handler`);
		// DHT is configured in server mode (clientMode: false) for LAN
		const dht = this.node.services.dht as any;
		if (dht) {
			const mode = dht.clientMode === false ? 'server' : 'client';
			console.log('✓ DHT running in', mode, 'mode');
		}
		this.pubsub.addEventListener('gossipsub:heartbeat', () => {
			const meshPeers = this.pubsub!.getMeshPeers(PINK_TOPIC);
			const subscribers = this.pubsub!.getSubscribers(PINK_TOPIC);
			const topics = this.pubsub!.getTopics();
			// console.log('💓 Heartbeat:');
			// console.log('💓  Connected libp2p peers:', this.node!.getPeers().length);
			// console.log('💓  My topics:', topics);
			// console.log('💓  Pink mesh peers:', meshPeers.length);
			// console.log('💓  Pink subscribers:', subscribers.length, subscribers.map(p => p.toString()).slice(0, 2));
			//console.log('💓peers:', this.node!.getPeers().length, 'mesh:', meshPeers.length, 'subs:', subscribers.length, 'topics:', topics.length);
		});
		this.pubsub.addEventListener('gossipsub:graft', evt => {
			console.log('🌿 GRAFT: ', evt.detail.peerId, ' joined ', evt.detail.topic);
			console.log('   Total mesh peers for ', evt.detail.topic, ':', this.pubsub!.getMeshPeers(evt.detail.topic).length);
		});
		this.pubsub.addEventListener('gossipsub:prune', evt => {
			console.log('✂️  PRUNE: peer left mesh');
			console.log('   Peer:', evt.detail.peerId);
			console.log('   Topic:', evt.detail.topic);
		});
		// Debug: Check peer store
		console.log('Peers in store:', this.node.getPeers().length);
		console.log('Services loaded:', Object.keys(this.node.services));
		// Create promise that resolves when first peer connects
		const firstPeerConnected = new Promise<void>(resolve => {
			if (this.node!.getPeers().length > 0) resolve();
			else this.node!.addEventListener('peer:connect', () => resolve(), { once: true });
		});
		// Listen for peer discovery and connection events
		this.node.addEventListener('peer:discovery', async evt => {
			const peerId = evt.detail.id.toString();
			const multiaddrs = evt.detail.multiaddrs?.map((ma: any) => ma.toString()) || [];
			console.log('🔍 Discovered peer:', peerId);
			console.log('   Multiaddrs from event:', multiaddrs.join(', ') || '(empty!)');
			// Check what's actually in peer store
			try {
				const peerData = await this.node!.peerStore.get(evt.detail.id);
				const tags = await (this.node!.peerStore as any).getTags(evt.detail.id);
				const storedAddrs = peerData.addresses.map((a: any) => a.multiaddr.toString());
				console.log('   Peer store addrs:', storedAddrs.join(', ') || '(empty!)');
				console.log('   Tags:', tags?.map((t: any) => `${t.name}=${t.value}`).join(', ') || 'none');
			} catch (e) {
				console.log('   Peer NOT in peer store');
			}
			// Check current connection status
			const connections = this.node!.getConnections(evt.detail.id);
			console.log('   Already connected:', connections.length > 0);
		});

		this.node.addEventListener('peer:connect', async evt => {
			const peerId = evt.detail.toString();
			const connections = this.node!.getConnections(evt.detail);
			const remoteAddrs = connections.map(c => c.remoteAddr.toString());
			console.log('✅ New peer connected:', peerId);
			console.log('   Remote addresses:', remoteAddrs.join(', '));
			console.log('   Total connected peers:', this.node!.getPeers().length);
			// Tag bootstrap peers with KEEP_ALIVE for automatic reconnection
			// Also refresh multiaddrs from the active connection to ensure reconnection works
			if (this.bootstrapPeerIds.has(peerId)) {
				const connectionMultiaddrs = connections.map(c => c.remoteAddr);
				await this.node!.peerStore.merge(evt.detail, {
					multiaddrs: connectionMultiaddrs, // Refresh addresses from active connection
					tags: {
						[KEEP_ALIVE]: { value: 1 },
					},
				});
				console.log('   Tagged as KEEP_ALIVE (bootstrap peer)');
				console.log('   Stored multiaddrs:', connectionMultiaddrs.map(ma => ma.toString()).join(', '));
			}
		});
		this.node.addEventListener('peer:disconnect', evt => {
			console.log('❌ lost connection with peer:', evt.detail.toString());
			console.log('   Total connected peers:', this.node!.getPeers().length);
		});
		// Relay event listeners
		this.node.addEventListener('relay:created-reservation' as any, (evt: any) => {
			console.log('🔄 Relay reservation created with:', evt.detail.relay.toString());
			console.log(
				'  (relay) Updated multiaddrs:',
				this.node!.getMultiaddrs().map(ma => ma.toString())
			);
		});
		this.node.addEventListener('relay:removed' as any, (evt: any) => {
			console.log('⚠️  Relay removed:', evt.detail.relay.toString());
		});
		this.node.addEventListener('relay:not-enough-relays' as any, (evt: any) => {
			console.log('⚠️  Not enough relays available');
		});
		this.node.addEventListener('relay:found-enough-relays' as any, (evt: any) => {
			console.log('✓ Found enough relays');
		});
		// Manually dial bootstrap peers FIRST, because config.peerDiscovery doesnt seem to work as expected
		// Bootstrap module discovers peers but doesn't auto-connect
		/*if (settings.network.bootstrapPeers?.length > 0) {
			//console.log('Connecting to bootstrap peers...');
			for (const peerAddr of settings.network.bootstrapPeers) {
				try {
					const ma = Multiaddr(peerAddr);
					await this.node.dial(ma);
					console.log('✓ Connected to bootstrap peer:', peerAddr);
				} catch (error: any) {
					console.log('✗ Failed to connect to bootstrap peer:', peerAddr, '-', error.message);
				}
			}

			// Wait for first peer to connect (with timeout)
			console.log('Waiting for peer connection...');
			const timeout = new Promise<void>(resolve => setTimeout(resolve, 5000));
			await Promise.race([firstPeerConnected, timeout]);

			if (this.node.getPeers().length > 0) {
				console.log('✓ Peer connected, proceeding');
			} else {
				console.log('⚠️  No peers connected after wait, continuing anyway');
			}
		}*/
		if (this.enablePink) {
			// console.log('  Libp2p peers:', this.node.getPeers().length);
			// console.log('  Pubsub peers:', this.pubsub.getPeers().length);
			// console.log('  Pubsub peer list:', this.pubsub.getPeers().map((p: any) => p.toString()));
			this.pingInterval = setInterval(async () => {
				await this.sendPink();
			}, 10000);
		}
		// Handle incoming messages
		this.pubsub.addEventListener('message', evt => {
			this.handleMessage(evt.detail);
		});
		//await this.subscribeToPink();
		await this.subscribeToLish();
		// Immediate bootstrap dial (workaround for libp2p bootstrap module not storing multiaddrs)
		if (AUTODIAL_WORKAROUND && this.bootstrapMultiaddrs.length > 0) {
			// Wait a bit for bootstrap module to try first, then dial directly
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
			}, 2000); // Wait 2s for bootstrap module to try first
		}
		// Periodic status log and optional autodial workaround
		this.statusInterval = setInterval(async () => {
			const connectedPeers = this.node!.getPeers();
			const allPeers = await this.node!.peerStore.all();
			console.log(`📊 Status: ${connectedPeers.length} connected, ${allPeers.length} in peer store`);
			if (AUTODIAL_WORKAROUND && connectedPeers.length === 0 && this.bootstrapMultiaddrs.length > 0) {
				console.log('   ⚠️  No connections - dialing bootstrap peers directly...');
				for (const ma of this.bootstrapMultiaddrs) {
					try {
						const peerId = ma.getPeerId();
						console.log(`   Dialing ${peerId?.slice(-8)}...`);
						await this.node!.dial(ma); // Dial with full multiaddr, not just peer ID
						console.log(`   ✓ Connected to ${peerId?.slice(-8)}`);
						break; // Stop after first successful connection
					} catch (err: any) {
						console.log(`   ✗ Failed to dial: ${err.message}`);
					}
				}
			}
		}, 10000);
		//this.addressInterval = setInterval(() => {this.printMultiaddrs()}, 30000);
	}

	private async subscribeToPink() {
		// Subscribe to pink and ponk topics - AFTER peer connection - does this matter?
		//console.log('Subscribing to pink and ponk topics');
		this.pubsub.subscribe(PINK_TOPIC);
		this.pubsub.subscribe(PONK_TOPIC);
		console.log('✓ Subscribed to topics:', this.pubsub.getTopics());
	}

	private handleMessage(msgEvent: any) {
		try {
			//console.log('Received message:', msgEvent.topic);
			const topic = msgEvent.topic;
			const data = new TextDecoder().decode(msgEvent.data);
			const message: Message = JSON.parse(data);
			console.log(`pubsub Received ${JSON.stringify(message)}`);
			if (topic === PINK_TOPIC) this.sendPonk(message.peerId);
		} catch (error) {
			console.error('Error in handleMessage:', error);
		}
	}

	public async sendPink() {
		if (!this.pubsub || !this.node) {
			console.error('Network not started');
			return;
		}

		// Check mesh peers for the pink topic
		const meshPeers = this.pubsub.getMeshPeers(PINK_TOPIC);
		const subscribers = this.pubsub.getSubscribers(PINK_TOPIC);
		console.log(`Sending pink (mesh: ${meshPeers.length} peers, subscribers: ${subscribers.length} peers)`);
		const message: PinkMessage = {
			type: 'pink',
			peerId: this.node.peerId.toString(),
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
		if (!this.pubsub || !this.node) {
			console.error('Network not started');
			return;
		}
		const message: PonkMessage = {
			type: 'ponk',
			peerId: this.node.peerId.toString(),
			timestamp: Date.now(),
			inReplyTo,
		};
		const data = new TextEncoder().encode(JSON.stringify(message));
		try {
			await this.pubsub.publish(PONK_TOPIC, data);
			console.log(`Sent ponk to ${inReplyTo}`);
		} catch (error) {
			console.log(`Ponk reply attempted (no peers connected)`);
		}
	}

	private async subscribeToLish() {
		if (!this.pubsub) {
			console.error('Network not started');
			return;
		}
		await this.subscribe(LISH_TOPIC, (data: any) => {
			console.log('Received pubsub LISH_TOPIC message:', data);
			this.handleWant(data);
		});
		console.log(`✓ Subscribed to LISH_TOPIC`);
	}

	private async handleWant(data: WantMessage) {
		console.log('Handling want message for lishId:', data.lishId);
		let manifest = await this.dataServer.getManifest(data.lishId);
		if (!manifest) return;
		let haveChunks = await this.dataServer.getHaveChunks(manifest);
		console.log('mock have:', this.dataDir, this.dataDir === '../../data1');
		if (this.dataDir === '../../data1') haveChunks = 'all';
		if (haveChunks !== 'all' && haveChunks.size === 0) {
			console.log('No chunks available to send Have message for lishId:', data.lishId);
			return;
		}
		console.log('Manifest found, sending Have');
		const haveMessage: HaveMessage = {
			type: 'have',
			lishId: manifest.id,
			chunks: haveChunks === 'all' ? 'all' : Array.from(haveChunks),
			multiaddrs: this.node!.getMultiaddrs(),
			peerId: this.node!.peerId.toString(),
		};
		await this.broadcast(LISH_TOPIC, haveMessage);
	}

	async broadcast(topic: string, data: any) {
		if (!this.pubsub || !this.node) {
			console.error('Network not started');
			return;
		}
		console.log(`Broadcasting to topic ${topic}:`, data.type);
		const encoded = new TextEncoder().encode(JSON.stringify(data));
		await this.pubsub.publish(topic, encoded);
	}

	async subscribe(topic: string, handler: (data: any) => void) {
		if (!this.pubsub) {
			console.error('Network not started');
			return;
		}
		this.pubsub.subscribe(topic);
		this.pubsub.addEventListener('message', evt => {
			if (evt.detail.topic === topic) {
				try {
					const data = new TextDecoder().decode(evt.detail.data);
					const parsed = JSON.parse(data);
					handler(parsed);
				} catch (error) {
					console.error('Error parsing message:', error);
				}
			}
		});
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
			// Check if it's a relay address (contains p2p-circuit protocol)
			const protos = addr.protos();
			if (protos.some(p => p.name === 'p2p-circuit')) {
				emoji = '🔄';
			} else {
				// Get the node address to check IP type
				try {
					const nodeAddr = addr.nodeAddress();
					if (nodeAddr.address === '127.0.0.1' || nodeAddr.address === '::1')
						emoji = '🏠'; // Localhost
					else if (nodeAddr.family === 4) {
						const octets = nodeAddr.address.split('.').map(Number);
						// Check for private IPv4 ranges
						if (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168)) {
							emoji = '🏢'; // LAN
						} else emoji = '🌍'; // WAN
					} else if (nodeAddr.family === 6) {
						// For IPv6, simple check for link-local (fe80::) or ULA (fc00::/7)
						if (nodeAddr.address.startsWith('fe80:') || nodeAddr.address.startsWith('fc'))
							emoji = '🏢'; // LAN
						else emoji = '🌍'; // WAN
					}
				} catch (e) {
					// nodeAddress() might not work for all multiaddr types, keep default emoji
				}
			}
			console.log(`${emoji} ${addr.toString()}`);
		});
	}

	// Open a stream to a peer with a specific protocol
	async dialProtocol(peerId: string, multiaddrs: any[], protocol: string) {
		if (!this.node) throw new Error('Network not started');
		// Dial the peer
		const connection = await this.node.dial(multiaddrs);
		// Open a stream with the protocol
		// runOnLimitedConnection allows opening streams even on relay/limited connections
		const stream = await connection.newStream(protocol, { runOnLimitedConnection: true });
		return stream;
	}

	async stop() {
		if (this.pingInterval) {
			clearInterval(this.pingInterval);
			this.pingInterval = null;
		}
		if (this.addressInterval) {
			clearInterval(this.addressInterval);
			this.addressInterval = null;
		}
		if (this.statusInterval) {
			clearInterval(this.statusInterval);
			this.statusInterval = null;
		}
		if (this.node) {
			await this.node.stop();
			console.log('Network stopped');
		}
		if (this.datastore) {
			await this.datastore.close();
			console.log('Datastore closed');
		}
	}

	async cliFindPeer(peerId: string) {
		const id = peerIdFromString(peerId);
		await this.findPeer(id);
	}

	async findPeer(peerId: PeerId) {
		console.log('Finding peer:');
		console.log('Closest peers:');
		for await (const peer of this.node.peerRouting.getClosestPeers(peerId.toMultihash().bytes)) {
			console.log(peer.id, peer.multiaddrs);
		}
		const peer: PeerInfo = await this.node.peerRouting.findPeer(peerId);
		console.log('Found it, multiaddrs are:');
		peer.multiaddrs.forEach(ma => console.log(ma.toString()));
	}
}
