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
import { mdns } from '@libp2p/mdns';
import { ping } from '@libp2p/ping';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { autoNATv2 } from '@libp2p/autonat-v2';
import { simpleMetrics } from '@libp2p/simple-metrics';
import { onLibp2pMetrics } from '../monitoring/libp2p-metrics.ts';
import { dcutr } from '@libp2p/dcutr';
import { networkInterfaces } from 'os';
import { isLinkLocalIp } from '@libp2p/utils';
import { type PrivateKey } from '@libp2p/interface';
import { type SettingsData } from '../settings.ts';
import { trace } from '../logger.ts';
import { normalizeTrustedPeerIds, parseAcceptPXThreshold } from './constants.ts';
const { multiaddr: Multiaddr } = await import('@multiformats/multiaddr');
export interface BuildConfigParams {
	privateKey: PrivateKey;
	datastore: any;
	allSettings: SettingsData;
	bootstrapPeers: string[];
	myPeerID: string;
}
export interface BuildConfigResult {
	config: any;
	port: number;
	bootstrapPeerIDs: Set<string>;
	bootstrapMultiaddrs: any[];
}

export function buildLibp2pConfig(params: BuildConfigParams): BuildConfigResult {
	const { privateKey, datastore, allSettings, bootstrapPeers, myPeerID: myPeerID } = params;
	const bootstrapPeerIDs = new Set<string>();
	const bootstrapMultiaddrs: any[] = [];
	const peerExchange = allSettings.network?.peerExchange;
	const pxEnabled = peerExchange?.enabled === true;
	const parsedThreshold = parseAcceptPXThreshold(peerExchange?.acceptPXThreshold);
	const acceptPXThreshold = parsedThreshold.value;
	if (parsedThreshold.unsafe) console.warn(`[NET] PX acceptPXThreshold=${String(parsedThreshold.raw)} is unsafe; using ${acceptPXThreshold}`);
	const trustedPXPeerIDs = normalizeTrustedPeerIds(peerExchange?.trustedPeerIds);
	if (pxEnabled) console.log(`[NET] PX enabled by local policy (trustedPeers=${trustedPXPeerIDs.size}, acceptPXThreshold=${acceptPXThreshold})`);
	else console.debug('[NET] PX disabled by local policy');
	// Build transports array
	const transports: any[] = [tcp()];
	// discoverRelays actively negotiates a reservation with the first N
	// relay-capable peers identified via peer:identify, instead of waiting
	// passively for /p2p-circuit multiaddrs to be announced. Without this,
	// NAT'd nodes (<redacted-arm-peer>, local, docker behind NAT) never get reservations
	// and are unreachable from siblings that only know their private IPs.
	// discoverRelays should match maxRelays (/p2p-circuit slots, below) so we
	// advertise as many reserved relay paths as we listen for. With 2 we'd
	// saturate on <redacted-bootstrap>+<redacted-bootstrap> only; with 5 we can include siblings as relays
	// too, giving NAT'd nodes multiple paths to reach each other.
	transports.push(circuitRelayTransport({ discoverRelays: 5 } as any));
	console.log(`✓ Circuit relay client enabled (discoverRelays: 5)`);
	// Build listen addresses
	const port = allSettings.network?.incomingPort || 0;
	const listenAddresses = [`/ip4/0.0.0.0/tcp/${port}`];
	// Each /p2p-circuit slot accumulates Multiaddr objects from periodic relay
	// reservation refresh; 10 slots caused ~117k Multiaddr instances on <redacted-arm-peer>
	// (heap snapshot 2026-04-18). 5 keeps redundancy without the leak amplifier.
	const maxRelays = 5;
	for (let i = 0; i < maxRelays; i++) listenAddresses.push('/p2p-circuit');
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
			// Skip link-local (169.254.0.0/16) — announcing these never helps
			// a remote peer and pollutes the peerStore with unreachable addresses.
			if (addr.family === 'IPv4' && !addr.internal && !isLinkLocalIp(addr.address)) {
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
		// Metrics snapshot every 5s → monitoring/memory-trace picks the relevant
		// counters on its own sample cadence. Used to correlate RSS growth with
		// libp2p internal collection sizes during leak investigations.
		metrics: simpleMetrics({ intervalMs: 5000, onMetrics: onLibp2pMetrics }),
		transports,
		connectionEncrypters: [noise({ crypto: pureJsCrypto })],
		streamMuxers: [yamux()],
		connectionManager: {
			maxConnections: 100,
		},
		// No connectionProtector - swarm key removed. Open network, isolation via topics.
		peerStore: {
			threshold: 15,
			// Moderate pruning — circuit-relay addresses re-created on every
			// reservation refresh (~minute); default 1h kept stale duplicates.
			// 300_000/1_800_000 (5m/30m) was too aggressive: connections evicted
			// mid-handshake caused StreamStateError flood from gossipsub sendRpc
			// writing to closed streams (100+/h), which in turn prevented
			// SUBSCRIBE RPC propagation → fragmented pubsub mesh.
			maxAddressAge: 1_800_000, // 30 min (default 3_600_000 = 1h)
			maxPeerAge: 7_200_000, // 2h (default 21_600_000 = 6h)
		},
		services: {
			identify: identify(),
			identifyPush: identifyPush(),
			ping: ping(),
			pubsub: gossipsub({
				emitSelf: false,
				allowPublishToZeroTopicPeers: true,
				floodPublish: true,
				D: 3,
				Dlo: 2,
				Dhi: 6,
				Dout: 0,
				Dlazy: 3,
				heartbeatInterval: 1000,
				fanoutTTL: 60000,
				runOnLimitedConnection: true,
				// Peer exchange is a local operator policy. A peer is considered trusted
				// for PX if it is either (a) explicitly listed in peerExchange.trustedPeerIds
				// (manual operator opt-in) OR (b) one of the bootstrap peers for any of the
				// lishnets this node is a member of (bootstrap = "operator deliberately chose
				// this peer for discovery", so extending the same trust to PX is a natural
				// default and avoids the cold-start problem where an empty trustedPeerIds
				// list plus a positive acceptPXThreshold meant PX was effectively dead).
				doPX: pxEnabled,
				scoreParams: {
					topicScoreCap: 10.0,
					appSpecificWeight: 1.0,
					appSpecificScore: (peerId: any) => {
						const pid = typeof peerId === 'string' ? peerId : (peerId?.toString?.() ?? '');
						const isConfiguredTrustedPXPeer = trustedPXPeerIDs.has(pid);
						const isBootstrapPeer = bootstrapPeerIDs.has(pid);
						const isTrustedPXPeer = pxEnabled && (isConfiguredTrustedPXPeer || isBootstrapPeer);
						// Trace a bounded sample so score callbacks do not flood logs.
						const dbg = ((globalThis as any).__libersharePXScoreDbg ??= { seen: new Set<string>(), trustedLogged: new Set<string>() });
						if (!dbg.seen.has(pid) && dbg.seen.size < 20) {
							dbg.seen.add(pid);
							trace(`[NET] PX trust score check peer=${pid.slice(0, 16)} enabled=${pxEnabled} configuredTrusted=${isConfiguredTrustedPXPeer} bootstrap=${isBootstrapPeer} trustedSetSize=${trustedPXPeerIDs.size} bootstrapSetSize=${bootstrapPeerIDs.size}`);
						}
						if (isTrustedPXPeer && !dbg.trustedLogged.has(pid)) {
							dbg.trustedLogged.add(pid);
							console.debug(`[NET] PX trust score applied peer=${pid.slice(0, 16)} source=${isConfiguredTrustedPXPeer ? 'configured' : 'bootstrap'}`);
						}
						return isTrustedPXPeer ? 1000 : 0;
					},
					// Sybil protection: penalize many peers from same IP.
					// Threshold 10 tolerates home NAT / hosting colocation; above that,
					// each extra peer from same IP accrues quadratic penalty.
					IPColocationFactorWeight: -5,
					IPColocationFactorThreshold: 10,
					// Behavior penalty (P7): default anti-flood against GRAFT backoff abuse.
					behaviourPenaltyWeight: -10,
					behaviourPenaltyDecay: 0.999,
					behaviourPenaltyThreshold: 0,
					decayInterval: 1000,
					decayToZero: 0.01,
					// Retain score for 15 min after disconnect — prevents cycling
					// disconnect-reconnect to reset accumulated penalties.
					retainScore: 900_000,
				},
				scoreThresholds: {
					gossipThreshold: -10,
					publishThreshold: -50,
					graylistThreshold: -80,
					// Positive threshold prevents neutral peers from supplying PX.
					acceptPXThreshold,
					// Default +20 nedosažitelné. 1 = aktivní peer po ~5 min do mesh.
					opportunisticGraftThreshold: 1,
				},
			}),
			// DHT removed entirely — only used by debug `lishnets.findPeer` API
			// (see network.ts:825). Real peer discovery uses gossipsub mesh +
			// bootstrap peers. Removal saves 100-300 MB peak burst from
			// TABLE_REFRESH (5min, 15×K=20 RPC) + querySelf + routing table
			// maintenance. clientMode option deprecated by removing service.
		},
	};
	// Add relay server service if enabled
	if (allSettings.network?.allowRelay) {
		const maxReservationsRaw = allSettings.network?.maxRelayReservations ?? 0;
		const maxReservations = maxReservationsRaw === 0 ? Infinity : maxReservationsRaw;
		config.services.relay = circuitRelayServer({
			reservations: {
				maxReservations,
				defaultDataLimit: BigInt(1024 * 1024 * 1024), // 1GB (default: 128KB — kills file transfers)
				defaultDurationLimit: 30 * 60 * 1000, // 30 min (default: 2 min)
			},
		});
		console.log(`✓ Circuit relay server enabled (maxReservations: ${maxReservationsRaw === 0 ? 'unlimited' : maxReservationsRaw}, dataLimit: 1GB, duration: 30min)`);
	}
	// AutoNAT v2 adds amplification-attack protection (maxDialDataBytes)
	// and supersedes v1, which upstream deprecated.
	config.services.autonat = autoNATv2();
	config.services.dcutr = dcutr();
	console.log('✓ AutoNAT v2 + DCUtR enabled');
	// Build peerDiscovery array: bootstrap (if peers provided) + mDNS (if enabled).
	const peerDiscovery: any[] = [];

	// Deduplicate bootstrap peers and filter out our own peer ID
	const uniqueBootstrapPeers = [...new Set(bootstrapPeers)].filter(p => !p.includes(myPeerID));
	if (uniqueBootstrapPeers.length > 0) {
		console.log('Configuring bootstrap peers:');
		const validBootstrapPeers: string[] = [];
		for (const peer of uniqueBootstrapPeers) {
			console.log('  -', peer);
			try {
				const ma = Multiaddr(peer);
				const peerID = ma.getComponents().find(c => c.code === 421)?.value ?? null;
				if (peerID) {
					bootstrapPeerIDs.add(peerID);
					bootstrapMultiaddrs.push(ma);
				}
				validBootstrapPeers.push(peer);
			} catch (error: any) {
				console.log('  ⚠️  Skipping invalid multiaddr:', peer, '-', error.message);
			}
		}
		if (validBootstrapPeers.length > 0) {
			peerDiscovery.push(
				bootstrap({
					list: validBootstrapPeers,
					timeout: 1000,
					tagTTL: 2147483647,
					tagValue: 100,
				})
			);
		}
	} else console.log('No bootstrap peers configured. Node will start in standalone mode.');

	// mDNS LAN discovery (multicast 224.0.0.251:5353).
	// Only useful for nodes on the same L2 network. WAN peers are unreachable
	// via mDNS — bootstrap + gossipsub mesh handles WAN.
	// Default ON since cost is negligible (~1 packet / interval) and gain
	// (zero-config LAN peer discovery) is high.
	const mdnsEnabled = allSettings.network?.mdnsEnabled ?? true;
	if (mdnsEnabled) {
		const mdnsInterval = allSettings.network?.mdnsInterval ?? 10000;
		peerDiscovery.push(
			mdns({
				interval: mdnsInterval,
			})
		);
		console.log(`✓ mDNS LAN discovery enabled (interval ${mdnsInterval}ms)`);
	}

	if (peerDiscovery.length > 0) {
		config.peerDiscovery = peerDiscovery;
	}

	return { config, port, bootstrapPeerIDs: bootstrapPeerIDs, bootstrapMultiaddrs };
}
