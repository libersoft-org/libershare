import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { bootstrap } from '@libp2p/bootstrap';
import { kadDHT } from '@libp2p/kad-dht';
import { ping } from '@libp2p/ping';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { autoNAT } from '@libp2p/autonat';
import { LevelDatastore } from 'datastore-level';
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import type { Libp2p } from 'libp2p';
import type { PrivateKey } from '@libp2p/interface';
import { readFileSync } from 'fs';
import { join } from 'path';
const { multiaddr: Multiaddr } = await import('@multiformats/multiaddr');

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
	replyTo: string;
}

const PINK_TOPIC = 'pink';
const PONK_TOPIC = 'ponk';
const PRIVATE_KEY_PATH = '/local/privatekey';

type Message = PinkMessage | PonkMessage;

export class Network {
	private node: Libp2p | null = null;
	private pubsub: PubSub | null = null;
	private datastore: LevelDatastore | null = null;
	private dataDir: string;
	private pingInterval: NodeJS.Timeout | null = null;
	private enablePink: boolean;

	constructor(dataDir: string = './data', enablePink: boolean = false) {
		this.dataDir = dataDir;
		this.enablePink = enablePink;
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


		// Initialize datastore
		const datastorePath = join(this.dataDir, 'datastore');
		this.datastore = new LevelDatastore(datastorePath);
		await this.datastore.open();
		console.log('✓ Datastore opened at:', datastorePath);
		const privateKey = await this.loadOrCreatePrivateKey(this.datastore);


		// Build transports array
		const transports: any[] = [tcp()];

		// Add circuit relay transport if client mode is enabled
		const relayClientMode = settings.relay?.client?.mode || 'force';
		const relayClientEnabled = (relayClientMode === 'force' || relayClientMode === 'auto');
		if (relayClientEnabled) {
			transports.push(circuitRelayTransport());
			console.log(`✓ Circuit relay client enabled (mode: ${relayClientMode})`);
		}

		// Build listen addresses
		const listenAddresses = [`/ip4/0.0.0.0/tcp/${settings.network.port}`];
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
			connectionEncrypters: [noise()],
			streamMuxers: [yamux()],
			connectionManager: {
				minConnections: 1, // Auto-dial to maintain at least 1 connection
				maxConnections: 100,
				autoDial: true,
				autoDialInterval: 1000,
			},
			peerStore: {
				persistence: true,
				threshold: 15,
			},
			services: {
				identify: identify(),
				ping: ping(),
				pubsub: gossipsub({
					emitSelf: false,
					allowPublishToZeroTopicPeers: true,
					floodPublish: true,  // Send to all peers, not just mesh (for small networks)
					D: 8,
					Dlo: 1,
					Dhi: 10,
				}),
				dht: kadDHT({
					clientMode: false,
				}),
			},
		};

		// Add relay server service if enabled
		if (settings.relay?.server?.enabled) {
			const maxReservations = settings.relay.server.maxReservations || 15;
			config.services.relay = circuitRelayServer({
				reservations: {
					maxReservations
				}
			});
			console.log(`✓ Circuit relay server enabled (maxReservations: ${maxReservations})`);
		}

		// Add autonat service if client mode is 'auto'
		if (relayClientMode === 'auto') {
			config.services.autonat = autoNAT();
			console.log('✓ AutoNAT enabled');
		}




		// Add bootstrap if peers are configured
		if (settings.network.bootstrapPeers.length > 0) {
			console.log('Configuring bootstrap peers:');
			settings.network.bootstrapPeers.forEach(peer => console.log('  -', peer));
			config.peerDiscovery = [
				bootstrap({
					list: settings.network.bootstrapPeers,
					timeout: 1000, // Wait 1 second before starting discovery
					//tagTTL: Infinity, // Keep bootstrap peers connected
				}),
			];
		}



		console.log('Port:', settings.network.port);
		this.node = await createLibp2p(config);
		await this.node.start();
		const addresses = this.node.getMultiaddrs();
		console.log('Node started with ID:', this.node.peerId.toString());
		console.log('Listening on addresses:');
		addresses.forEach(addr => console.log('  -', addr.toString()));

		this.pubsub = this.node.services.pubsub as PubSub;



		// DHT is configured in server mode (clientMode: false) for LAN
		const dht = this.node.services.dht as any;
		if (dht) {
			const mode = dht.clientMode === false ? 'server' : 'client';
			console.log('✓ DHT running in', mode, 'mode');
		}





		//if (this.enablePink)
		{
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

			this.pubsub.addEventListener('gossipsub:graft', (evt) => {
				console.log('🌿 GRAFT: ', evt.detail.peerId, ' joined ', evt.detail.topic);
				console.log('   Total mesh peers for ', evt.detail.topic, ':', this.pubsub!.getMeshPeers(evt.detail.topic).length);
			});

			this.pubsub.addEventListener('gossipsub:prune', (evt) => {
				console.log('✂️  PRUNE: peer left mesh');
				console.log('   Peer:', evt.detail.peerId);
				console.log('   Topic:', evt.detail.topic);
			});
		}






		// Debug: Check peer store
		console.log('Peers in store:', this.node.getPeers().length);
		console.log('Services loaded:', Object.keys(this.node.services));



		// Create promise that resolves when first peer connects
		const firstPeerConnected = new Promise<void>((resolve) => {
			if (this.node!.getPeers().length > 0) {
				resolve();
			} else {
				this.node!.addEventListener('peer:connect', () => resolve(), { once: true });
			}
		});



		// Listen for peer discovery and connection events
		this.node.addEventListener('peer:discovery', (evt) => {
			const peerId = evt.detail.id.toString();
			console.log('🔍 Discovered peer:', peerId);
		});

		this.node.addEventListener('peer:connect', (evt) => {
			console.log('✅ new connection with peer:', evt.detail.toString());
			console.log('   Total connected peers:', this.node!.getPeers().length);
		});

		this.node.addEventListener('peer:disconnect', (evt) => {
			console.log('❌ lost connection with peer:', evt.detail.toString());
			console.log('   Total connected peers:', this.node!.getPeers().length);
		});

		// Relay event listeners
		this.node.addEventListener('relay:created-reservation' as any, (evt: any) => {
			console.log('🔄 Relay reservation created with:', evt.detail.relay.toString());
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


		// Manually dial bootstrap peers FIRST
		// Bootstrap module discovers peers but doesn't auto-connect
		if (settings.network.bootstrapPeers.length > 0) {
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
			const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
			await Promise.race([firstPeerConnected, timeout]);

			if (this.node.getPeers().length > 0) {
				console.log('✓ Peer connected, proceeding');
			} else {
				console.log('⚠️  No peers connected after wait, continuing anyway');
			}
		}


		// Subscribe to pink and ponk topics - AFTER peer connection - does this matter?
		console.log('Subscribing to pink and ponk topics');
		this.pubsub.subscribe(PINK_TOPIC);
		this.pubsub.subscribe(PONK_TOPIC);
		console.log('✓ Subscribed to topics:', this.pubsub.getTopics());



		if (this.enablePink)
		{
			// console.log('  Libp2p peers:', this.node.getPeers().length);
			// console.log('  Pubsub peers:', this.pubsub.getPeers().length);
			// console.log('  Pubsub peer list:', this.pubsub.getPeers().map((p: any) => p.toString()));

			this.pingInterval = setInterval(async () => {
				await this.sendPing();
			}, 10000);
		}

		// Handle incoming messages
		this.pubsub.addEventListener('message', evt => {
			this.handleMessage(evt.detail);
		});

	}

	private handleMessage(msgEvent: any) {
		try {
			//console.log('Received message:', msgEvent.topic);
			const topic = msgEvent.topic;
			const data = new TextDecoder().decode(msgEvent.data);
			const message: Message = JSON.parse(data);
			console.log(`Received ${JSON.stringify(message)}`);
			if (topic === PINK_TOPIC) {
				this.sendPong(message.peerId);
			}
		} catch (error) {
			console.error('Error in handleMessage:', error);
		}
	}


	private async sendPing() {
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

	private async sendPong(replyTo: string) {
		if (!this.pubsub || !this.node) {
			console.error('Network not started');
			return;
		}
		const message: PonkMessage = {
			type: 'ponk',
			peerId: this.node.peerId.toString(),
			timestamp: Date.now(),
			replyTo,
		};
		const data = new TextEncoder().encode(JSON.stringify(message));
		try {
			await this.pubsub.publish(PONK_TOPIC, data);
			console.log(`Sent ponk to ${replyTo}`);
		} catch (error) {
			console.log(`Ponk reply attempted (no peers connected)`);
		}
	}

	// async broadcast(topic: string, data: any) {
	// 	if (!this.pubsub) {
	// 		console.error('Network not started');
	// 		return;
	// 	}
	// 	const encoded = new TextEncoder().encode(JSON.stringify(data));
	// 	await this.pubsub.publish(topic, encoded);
	// }
	//
	// async subscribe(topic: string, handler: (data: any) => void) {
	// 	if (!this.pubsub) {
	// 		console.error('Network not started');
	// 		return;
	// 	}
	// 	this.pubsub.subscribe(topic);
	// 	this.pubsub.addEventListener('message', evt => {
	// 		if (evt.detail.topic === topic) {
	// 			try {
	// 				const data = new TextDecoder().decode(evt.detail.data);
	// 				const parsed = JSON.parse(data);
	// 				handler(parsed);
	// 			} catch (error) {
	// 				console.error('Error parsing message:', error);
	// 			}
	// 		}
	// 	});
	// }

	async connectToPeer(multiaddr: string) {
		if (!this.node) {
			throw new Error('Network not started');
		}
		const ma = Multiaddr(multiaddr);
		await this.node.dial(ma);
		console.log('→ Connected to:', multiaddr);
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
}

