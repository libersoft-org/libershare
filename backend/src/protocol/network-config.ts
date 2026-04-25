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
import { getLocalCidrs, shouldDenyDial, extractFirstIPv4 } from './address-filter.ts';
import { peerIdFromString } from '@libp2p/peer-id';
const { multiaddr: Multiaddr } = await import('@multiformats/multiaddr');

/**
 * Convert bootstrap multiaddr strings to gossipsub DirectPeer entries
 * ({ id: PeerId, addrs: Multiaddr[] }). Peers that lack a /p2p/<id> component
 * or whose components fail to parse are skipped. Result: a fresh node starts
 * inside the gossipsub mesh at config time, without waiting for the first
 * peer-announce discovery cycle to surface bootstraps as direct peers.
 */
function buildDirectPeersFromBootstrap(uniquePeers: string[]): Array<{ id: any; addrs: any[] }> {
	const direct: Array<{ id: any; addrs: any[] }> = [];
	for (const ma of uniquePeers) {
		try {
			const parsed = Multiaddr(ma);
			const pid = parsed.getComponents().find((c: any) => c.code === 421)?.value;
			if (!pid) continue;
			direct.push({ id: peerIdFromString(pid), addrs: [parsed] });
		} catch {
			/* unparseable multiaddr — skip silently */
		}
	}
	return direct;
}
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
	// Unique bootstrap peers computed up-front so gossipsub config below can
	// pre-populate directPeers from them.
	const uniqueBootstrapPeers = [...new Set(bootstrapPeers)].filter(p => !p.includes(myPeerID));
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
	// NAT'd nodes never get reservations and are unreachable from siblings
	// that only know their private IPs. discoverRelays should match maxRelays
	// (/p2p-circuit slots, below) so we advertise as many reserved relay
	// paths as we listen for. With only the two bootstrap peers as relays,
	// NAT'd nodes saturate on them; raising this lets siblings act as relays
	// too, giving NAT'd nodes multiple paths to reach each other.
	transports.push(circuitRelayTransport({ discoverRelays: 5 } as any));
	console.log(`✓ Circuit relay client enabled (discoverRelays: 5)`);
	// Build listen addresses
	const port = allSettings.network?.incomingPort || 0;
	const listenAddresses = [`/ip4/0.0.0.0/tcp/${port}`];
	// Each /p2p-circuit slot accumulates Multiaddr objects from periodic relay
	// reservation refresh; 10 slots were observed to produce ~117k Multiaddr
	// instances on a long-running node (heap snapshot captured during leak
	// investigation). 5 keeps redundancy without the leak amplifier.
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
			// Tuned for ~100-peer fleets. Each peer keeps gossipsub mesh (D=12 / Dhi=16)
			// + relay reservations + transient identify/AutoNAT dials. 300 leaves comfortable
			// headroom even when most of the fleet is reachable simultaneously.
			maxConnections: 300,
			// ReconnectQueue fires on peer:disconnect and retries with exponential backoff.
			// First retry at 500 ms (default 1000) — disconnected fleet peers come back
			// fast. Backoff factor 1.5 (default 2) softens the climb. Retry depth 15
			// covers peers whose first few retries hit a partition.
			reconnectRetries: 15,
			reconnectRetryInterval: 500,
			reconnectBackoffFactor: 1.5,
			maxParallelReconnects: 30,
		},
		// Deny dial attempts to multiaddrs that cannot possibly succeed from this
		// node's own interfaces. Peers advertise every known multiaddr (via
		// identify), so a public-IP node ends up with dozens of private-range
		// LAN addresses in its peerStore. Without this gater, every re-dial cycle
		// spawned 5s-timeout dials against all of them — pure waste.
		// Rules in address-filter.ts:
		//   DNS / p2p-circuit        → allow (no IPv4 yet, let libp2p resolve)
		//   127.x                    → deny (loopback useless for remote peer)
		//   public IPv4              → allow
		//   RFC1918 / LL / CGNAT     → allow iff IP falls inside one of our own
		//                              live-enumerated interface CIDRs.
		// VPN up/down is picked up within 10 s via the CIDR cache TTL.
		connectionGater: {
			denyDialMultiaddr: async (ma: any): Promise<boolean> => {
				// Bypass gater for trusted peers (bootstrap set ∪ configured trustedPeerIds).
				// Multi-subnet fleets (e.g. 192.168.2.x + 192.168.3.x) would otherwise have
				// trusted peers blocked when their advertised addr lives on a LAN segment
				// different from our own. Trusted peers are by policy known-good
				// destinations, so dial them regardless of CIDR match.
				const pidComponent = ma?.getComponents?.()?.find?.((c: any) => c.code === 421);
				const pid = pidComponent?.value ?? null;
				if (pid && (bootstrapPeerIDs.has(pid) || trustedPXPeerIDs.has(pid))) return false;
				const deny = shouldDenyDial(ma, getLocalCidrs());
				if (deny) {
					// Bounded debug sample so denied-dial flood does not overwhelm logs.
					const dbg = ((globalThis as any).__libershareDenyDialDbg ??= new Set<string>());
					if (dbg.size < 50) {
						const ip = extractFirstIPv4(ma) ?? '?';
						const addr = ma?.toString?.() ?? String(ma);
						if (!dbg.has(addr)) {
							dbg.add(addr);
							trace(`[NET] denyDial ip=${ip} ma=${addr.slice(0, 120)}`);
						}
					}
				}
				return deny;
			},
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
				// Pre-populate directPeers at config time from the bootstrap list.
				// Guarantees gossipsub stream membership at startup, before any
				// peer-announce cycle — without this, fresh nodes can sit at min=0
				// for tens of seconds because they aren't yet in any other peer's
				// flood-publish set. Runtime additions via gossipsub.direct still
				// happen in Network.promoteKnownPeersToBootstrap().
				directPeers: buildDirectPeersFromBootstrap(uniqueBootstrapPeers),
				// directConnectTicks 60 (default 300). At heartbeatInterval=500ms this
				// makes directPeers reconnect cadence 30s instead of 150s. directPeers
				// are never PRUNED by Dhi, guaranteeing mesh membership; lower cadence
				// surfaces lost connections fast enough to keep mesh stable.
				directConnectTicks: 60,
				// Gossipsub mesh sized for ~100-peer fleets.
				//   D=12   target mesh degree per peer
				//   Dlo=8  graft when below
				//   Dhi=16 prune when above (4 slots above D — modest opportunistic graft
				//          headroom; full TCP fullmesh is not the goal at this fleet size)
				//   Dout=0 asymmetric inbound bias (intentional)
				//   Dlazy=12 wider gossip fanout so IHAVE metadata reaches more peers
				//          per heartbeat, supporting dissemination of peer IDs (though
				//          not multiaddrs — those still need PX or peer-announce).
				// Theoretical reach: log(100)/log(12) ≈ 2 hops at heartbeat 500ms,
				// well below the human-perceptible delivery threshold.
				D: 12,
				Dlo: 8,
				Dhi: 16,
				Dout: 0,
				Dlazy: 12,
				// heartbeatInterval 500 (default 1000). Doubles gossipsub mesh
				// maintenance rate → doubles PRUNE frequency → doubles PX emission,
				// helpful for fleet convergence when PX is the primary peer-list source.
				heartbeatInterval: 500,
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
					// IP colocation factor: would penalise many peers reporting the same
					// public IP (sybil heuristic). Disabled (weight=0) because NAT'd fleet
					// peers legitimately share a public IP. Sybil protection in this code
					// path comes from acceptPXThreshold (only positively-scored peers may
					// supply PX) plus the ingress filter (peerExchange.ingressFilterEnabled).
					IPColocationFactorWeight: 0,
					IPColocationFactorThreshold: 50,
					// Behaviour penalty: anti-flood against GRAFT backoff abuse.
					// threshold=6 grants a warmup grace period (no penalty for first 6
					//   violations) so coordinated fleet restarts — where 20+ peers reconnect
					//   simultaneously and trip the counter naturally before stabilising —
					//   don't immediately graylist the whole fleet.
					// weight=-1 keeps long-term abuse linearly costly without producing
					//   the -1600 scores that earlier (-10 × counter²) settings caused.
					// decay=0.99 halves accumulated penalty every ~70s, so transient
					//   misbehaviour fades inside one steady-state interval.
					behaviourPenaltyWeight: -1,
					behaviourPenaltyDecay: 0.99,
					behaviourPenaltyThreshold: 6,
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
					// Accept any non-graylisted peer for opportunistic graft. The default
					// (1) gated too many neutral peers (score=0.0 is the norm for
					// freshly-joined nodes) from being pulled into mesh, slowing mesh
					// convergence in fleets where PX is the primary discovery path.
					opportunisticGraftThreshold: 0,
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

	// uniqueBootstrapPeers computed at top of function (used above for directPeers seed).
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
