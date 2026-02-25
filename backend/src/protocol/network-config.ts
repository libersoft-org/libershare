/**
 * Builds the libp2p node configuration from application settings and bootstrap peers.
 * Extracted from Network.start() for clarity and testability.
 */
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
import { networkInterfaces } from 'os';
import { type PrivateKey } from '@libp2p/interface';
import { type SettingsData } from '../settings.ts';
const { multiaddr: Multiaddr } = await import('@multiformats/multiaddr');
export interface BuildConfigParams {
	privateKey: PrivateKey;
	datastore: any;
	allSettings: SettingsData;
	bootstrapPeers: string[];
	myPeerId: string;
}
export interface BuildConfigResult {
	config: any;
	port: number;
	bootstrapPeerIds: Set<string>;
	bootstrapMultiaddrs: any[];
}

export function buildLibp2pConfig(params: BuildConfigParams): BuildConfigResult {
	const { privateKey, datastore, allSettings, bootstrapPeers, myPeerId } = params;
	const bootstrapPeerIds = new Set<string>();
	const bootstrapMultiaddrs: any[] = [];
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
		datastore,
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
					bootstrapPeerIds.add(peerID);
					bootstrapMultiaddrs.push(ma);
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
	return { config, port, bootstrapPeerIds, bootstrapMultiaddrs };
}
