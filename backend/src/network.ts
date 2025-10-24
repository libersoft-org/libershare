import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { bootstrap } from '@libp2p/bootstrap';
import { kadDHT } from '@libp2p/kad-dht';
import { ping } from '@libp2p/ping';
import { LevelDatastore } from 'datastore-level';
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { keychain } from '@libp2p/keychain';
import type { Libp2p } from 'libp2p';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { readFileSync } from 'fs';
import { join } from 'path';

// PubSub type - using any since the exact type isn't exported from @libp2p/interface v3
type PubSub = any;
interface PingMessage {
	type: 'ping';
	peerId: string;
	timestamp: number;
}
interface PongMessage {
	type: 'pong';
	peerId: string;
	timestamp: number;
	replyTo: string;
}
const PING_TOPIC = 'libershare/ping';
const PONG_TOPIC = 'libershare/pong';
const PRIVATE_KEY_PATH = '/local/privatekey';

type Message = PingMessage | PongMessage;

export class Network {
	private node: Libp2p | null = null;
	private pubsub: PubSub | null = null;
	private datastore: LevelDatastore | null = null;
	private dataDir: string;
	private pingInterval: NodeJS.Timeout | null = null;

	constructor(dataDir: string = './data') {
		this.dataDir = dataDir;
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
		// Load settings from dataDir
		const settingsPath = join(this.dataDir, 'settings.json');
		const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));

		console.log('Starting libp2p network...');
		console.log('Data directory:', this.dataDir);
		console.log('Port:', settings.network.port);
		console.log('Bootstrap peers:', settings.network.bootstrapPeers.length);

		// Initialize datastore
		const datastorePath = join(this.dataDir, 'datastore');
		this.datastore = new LevelDatastore(datastorePath);
		await this.datastore.open();
		console.log('✓ Datastore opened at:', datastorePath);

		// Load or create private key from datastore
		const privateKey = await this.loadOrCreatePrivateKey(this.datastore);

		// Create libp2p node with private key
		const config: any = {
			privateKey,
			datastore: this.datastore,
			addresses: {
				listen: [`/ip4/0.0.0.0/tcp/${settings.network.port}`],
			},
			transports: [tcp()],
			connectionEncrypters: [noise()],
			streamMuxers: [yamux()],
			connectionManager: {
				minConnections: 1, // Auto-dial to maintain at least 1 connection
				maxConnections: 100,
			},
			services: {
				identify: identify(),
				ping: ping(),
				pubsub: gossipsub({
					emitSelf: false,
					allowPublishToZeroTopicPeers: true,
					D: 2,  // Lower mesh size for small network
    Dlo: 1,
    Dhi: 3

				}),
				dht: kadDHT({
					clientMode: false
				}),
			}
		};

		// Add bootstrap if peers are configured
		if (settings.network.bootstrapPeers.length > 0) {
			console.log('Configuring bootstrap peers:');
			settings.network.bootstrapPeers.forEach(peer => console.log('  -', peer));
			config.peerDiscovery = [
				bootstrap({
					list: settings.network.bootstrapPeers,
					timeout: 1000, // Wait 1 second before starting discovery
					tagTTL: Infinity, // Keep bootstrap peers connected
				}),
			];
		}

		this.node = await createLibp2p(config);

		await this.node.start();

		// DHT is configured in server mode (clientMode: false) for LAN
		const dht = this.node.services.dht as any;
		if (dht) {
			const mode = dht.clientMode === false ? 'server' : 'client';
			console.log('✓ DHT running in', mode, 'mode');
		}

		this.pubsub = this.node.services.pubsub as PubSub;

		// Listen to gossipsub mesh events
		this.pubsub.addEventListener('gossipsub:heartbeat', () => {
			console.log('gossipsub:heartbeat');
			const meshPeers = this.pubsub!.getMeshPeers(PING_TOPIC);
			if (meshPeers.length > 0) {
				console.log('💓 Heartbeat - ping mesh peers:', meshPeers.length);
			}
		});

		this.pubsub.addEventListener('gossipsub:graft', (evt) => {
			console.log('🌿 GRAFT: peer joined mesh:', evt.detail.peerId);
		});

		this.pubsub.addEventListener('gossipsub:prune', (evt) => {
			console.log('✂️  PRUNE: peer left mesh:', evt.detail.peerId);
		});

		const addresses = this.node.getMultiaddrs();
		console.log('Node started with ID:', this.node.peerId.toString());
		console.log('Listening on addresses:');
		addresses.forEach(addr => console.log('  -', addr.toString()));

		// Debug: Check peer store
		console.log('Peers in store:', this.node.getPeers().length);
		console.log('Services loaded:', Object.keys(this.node.services));

		// Listen for peer discovery and connection events
		this.node.addEventListener('peer:discovery', (evt) => {
			const peerId = evt.detail.id.toString();
			console.log('🔍 Discovered peer:', peerId);
		});

		this.node.addEventListener('peer:connect', (evt) => {
			console.log('✅ Connected to peer:', evt.detail.toString());
			console.log('   Total connected peers:', this.node!.getPeers().length);
		});

		this.node.addEventListener('peer:disconnect', (evt) => {
			console.log('❌ Disconnected from peer:', evt.detail.toString());
			console.log('   Total connected peers:', this.node!.getPeers().length);
		});

		// Subscribe to ping and pong topics
		this.pubsub.subscribe(PING_TOPIC);
		this.pubsub.subscribe(PONG_TOPIC);
		// Handle incoming messages
		this.pubsub.addEventListener('message', evt => {
			this.handleMessage(evt.detail);
		});
		// Send initial ping to network
		await this.sendPing();
		console.log('Network ready. Listening for pings...');

		// Manually dial bootstrap peers
		// Bootstrap module discovers peers but doesn't auto-connect
		if (settings.network.bootstrapPeers.length > 0) {
			const { multiaddr: Multiaddr } = await import('@multiformats/multiaddr');
			for (const peerAddr of settings.network.bootstrapPeers) {
				try {
					const ma = Multiaddr(peerAddr);
					await this.node.dial(ma);
					console.log('✓ Connected to bootstrap peer:', peerAddr);
				} catch (error: any) {
					console.log('✗ Failed to connect to bootstrap peer:', peerAddr, '-', error.message);
				}
			}
		}

		// Start periodic ping timer (every 30 seconds)
		this.pingInterval = setInterval(async () => {
			await this.sendPing();
		}, 3000);
	}

	private handleMessage(msgEvent: any) {
		try {
			const topic = msgEvent.topic;
			const data = new TextDecoder().decode(msgEvent.data);
			const message: Message = JSON.parse(data);
			if (topic === PING_TOPIC && message.type === 'ping') {
				console.log(`Received ping from ${message.peerId} at ${new Date(message.timestamp).toISOString()}`);
				this.sendPong(message.peerId);
			} else if (topic === PONG_TOPIC && message.type === 'pong') {
				console.log(`Received pong from ${message.peerId} (reply to ${message.replyTo}) at ${new Date(message.timestamp).toISOString()}`);
			}
		} catch (error) {
			console.error('Error handling message:', error);
		}
	}

	private async sendPing() {
		if (!this.pubsub || !this.node) {
			console.error('Network not started');
			return;
		}

		// Check mesh peers for the ping topic
		const meshPeers = this.pubsub.getMeshPeers(PING_TOPIC);
		const subscribers = this.pubsub.getSubscribers(PING_TOPIC);
		console.log(`Sending ping (mesh: ${meshPeers.length} peers, subscribers: ${subscribers.length} peers)`);

		const message: PingMessage = {
			type: 'ping',
			peerId: this.node.peerId.toString(),
			timestamp: Date.now(),
		};
		const data = new TextEncoder().encode(JSON.stringify(message));
		try {
			await this.pubsub.publish(PING_TOPIC, data);
		} catch (error) {
			console.log('Error sending ping:', error);
		}
	}

	private async sendPong(replyTo: string) {
		if (!this.pubsub || !this.node) {
			console.error('Network not started');
			return;
		}
		const message: PongMessage = {
			type: 'pong',
			peerId: this.node.peerId.toString(),
			timestamp: Date.now(),
			replyTo,
		};
		const data = new TextEncoder().encode(JSON.stringify(message));
		try {
			await this.pubsub.publish(PONG_TOPIC, data);
			console.log(`Sent pong to ${replyTo}`);
		} catch (error) {
			console.log(`Pong reply attempted (no peers connected)`);
		}
	}

	async broadcast(topic: string, data: any) {
		if (!this.pubsub) {
			console.error('Network not started');
			return;
		}
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
	}

	async connectToPeer(multiaddr: string) {
		if (!this.node) {
			console.error('Network not started');
			return;
		}
		try {
			const { multiaddr: Multiaddr } = await import('@multiformats/multiaddr');
			const ma = Multiaddr(multiaddr);
			await this.node.dial(ma);
			console.log('Connected to peer:', multiaddr);
		} catch (error) {
			console.error('Failed to connect to peer:', error);
		}
	}

	async stop() {
		if (this.pingInterval) {
			clearInterval(this.pingInterval);
			this.pingInterval = null;
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

	getPeerId(): string | null {
		return this.node ? this.node.peerId.toString() : null;
	}

	getConnectedPeers(): string[] {
		if (!this.node) return [];
		return Array.from(this.node.getPeers()).map(peerId => peerId.toString());
	}
}

// Example usage
if (import.meta.main) {
	// Parse command line arguments
	const args = process.argv.slice(2);
	let dataDir = './data';

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--datadir' && i + 1 < args.length) {
			dataDir = args[i + 1];
			break;
		}
	}

	const network = new Network(dataDir);
	await network.start();
	// Keep the process running
	process.on('SIGINT', async () => {
		console.log('\nShutting down...');
		await network.stop();
		process.exit(0);
	});
}
