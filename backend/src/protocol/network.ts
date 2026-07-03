import { createLibp2p } from 'libp2p';
import { KEEP_ALIVE } from '@libp2p/interface';
import { SqliteDatastore } from './datastore.ts';
import { privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { loadOrCreatePrivateKey, writeIdentityKey as writeIdentityKeyToDatastore, clearIdentityKey as clearIdentityKeyFromDatastore, clearDatastore as clearDatastoreDir, clearPeerstoreOnly } from './identity-store.ts';
import { type Libp2p } from 'libp2p';
import { type PeerId as PeerID, type PrivateKey, type Stream } from '@libp2p/interface';
import { peerIdFromString as peerIDFromString } from '@libp2p/peer-id';
import { join } from 'path';
import { trace } from '../logger.ts';
import { DataServer } from '../lish/data-server.ts';
import { type Settings } from '../settings.ts';
import { LISH_PROTOCOL, handleLISHProtocol } from './lish-protocol.ts';
import { buildLibp2pConfig } from './network-config.ts';
import { type WantMessage } from './downloader.ts';
import { lishTopic, LISH_TOPIC_PREFIX } from './constants.ts';
import { getLocalCidrs, shouldDenyDial } from './address-filter.ts';
import { CodedError, ErrorCodes, type NetworkNodeInfo, type PeerConnectionInfo, type IMeshHealth, type BootstrapStatus, type BootstrapPeerDialStatus, type BootstrapPeerOrigin } from '@shared';
import { Circuit } from '@multiformats/multiaddr-matcher';
import { createTopicScoreParams } from '@chainsafe/libp2p-gossipsub/score';
import { multiaddr as Multiaddr } from '@multiformats/multiaddr';
import { applyGossipsubPatches } from './gossipsub-patches.ts';
import { BootstrapStatusTracker } from './bootstrap-status.ts';
import { logStatusDebug, dumpGossipsubScores } from './status-logger.ts';
import { classifyConnection as classifyConnectionFn, dialProtocol as dialProtocolFn, dialProtocolByPeerId as dialProtocolByPeerIdFn, connectToPeer as connectToPeerFn } from './dial-helpers.ts';
import { LISHServingHandlers, type SearchLishsMessage } from './lish-handlers.ts';
export type { SearchLishsMessage } from './lish-handlers.ts';
export { isSearchAdvertisableLish } from './lish-handlers.ts';
import { PeerAnnounceManager, type PeerAnnounceMessage } from './peer-announce.ts';
type PubSub = any; // PubSub type - using any since the exact type isn't exported from @libp2p/interface v3

/** Result of dialing a protocol stream: the opened stream plus how the underlying connection is routed. */
export interface IDialResult {
	stream: Stream;
	connectionType: 'DIRECT' | 'RELAY' | 'DCUtR';
}

/** Exported node identity: peer ID plus the private key in libp2p protobuf format. */
export interface IExportedIdentity {
	peerID: string;
	privateKeyBytes: Uint8Array;
}

/**
 * Per-network entry of the `peers:count` API event. The `count` field is the
 * subscriber count to the lishnet topic (peers we know are listening); the
 * remaining fields are a snapshot of mesh health used by the UI to colour the
 * network indicator without making a separate poll. See
 * {@link Network.getMeshHealth} for semantics of the mesh-health fields.
 */
export interface PeerCountEntry {
	networkID: string;
	count: number;
	meshSize: number;
	/** Milliseconds since the last graft/prune at the moment the event was
	 * emitted, or `null` if no graft/prune has ever been observed on this
	 * topic (mesh still forming). The frontend should anchor a non-null
	 * value to its own clock and recompute elapsed time client-side instead
	 * of polling. */
	stableSinceMs: number | null;
	medianScore: number | null;
}

/** Raw gossipsub message event. */
interface PubsubEvent {
	topic: string;
	data: Uint8Array;
	/** Cryptographically-verified peer ID of the original publisher (provided by libp2p gossipsub). */
	from?: { toString(): string };
}
/**
 * Handler for parsed pubsub topic messages.
 * `from` is the original publisher peer ID (verified by libp2p) when available —
 * used for per-source rate-limiting in handleWant.
 * Handlers may be async (e.g. catalog op application) — dispatch awaits them.
 */
type TopicHandler = (data: Record<string, any>, from?: string) => void | Promise<void>;
const AUTODIAL_WORKAROUND = true;
/** Minimum interval between two `have` responses sent to the same peer for the same LISH. */
const WANT_RESPONSE_COOLDOWN_MS = 60_000;
/** Periodic cleanup of stale entries in lastWantResponseTime (entries older than the cooldown are useless). */
const WANT_RESPONSE_CLEANUP_INTERVAL_MS = 5 * 60_000;
/** Search query dedup window — same `searchID` arriving via mesh within this period is ignored. */
const SEARCH_DEDUP_TTL_MS = 5 * 60_000;
/**
 * Maximum size (bytes) of an incoming pubsub payload we are willing to decode.
 * Our own control messages ride pubsub (WANT — tiny JSON), but older/foreign peers
 * still broadcast HAVE announcements and catalog inventories on the same topic and
 * those can reach tens of KB for nodes with large libraries. A too-small cap silently
 * dropped those messages so peer presence info never reached topic handlers (observed
 * ~46 KB payloads from peers with large catalogs). 256 KiB fits realistic HAVE/catalog
 * frames while still bounding the damage a malicious publisher can do per message.
 */
const MAX_PUBSUB_PAYLOAD_BYTES = 256 * 1024;

/**
 * Single shared libp2p node.
 * LISH networks are logical groups represented as pubsub topics on this one node.
 */
export class Network {
	private node: Libp2p | null = null;
	private pubsub: PubSub | null = null;
	private datastore: SqliteDatastore | null = null;
	private currentPrivateKey: PrivateKey | null = null;
	private readonly dataServer: DataServer;
	private readonly dataDir: string;
	private statusInterval: NodeJS.Timeout | null = null;
	/** Monotonic counter for status-interval ticks. Used by the periodic autodial promotion. */
	private statusTickCount = 0;
	/**
	 * Per-(peer,lish) timestamp of the last `have` response we sent.
	 * Used to rate-limit responses to repeated `want` queries from the same peer for the same LISH:
	 * we respond at most once per WANT_RESPONSE_COOLDOWN_MS. Periodic cleanup removes stale entries.
	 */
	private readonly lastWantResponseTime = new Map<string, number>();
	private wantResponseCleanupInterval: NodeJS.Timeout | null = null;
	/**
	 * Recently-seen search IDs, used to dedupe `searchLishs` queries arriving multiple times via
	 * the gossipsub mesh. Pruned periodically with the same cleanup interval as `lastWantResponseTime`.
	 */
	private readonly seenSearchIDs = new Map<string, number>();
	private bootstrapPeerIDs: Set<string> = new Set();
	private dcutrPeers: Set<string> = new Set();
	private bootstrapMultiaddrs: any[] = [];

	// Topic handlers: topic -> Set of handler functions
	private topicHandlers: Map<string, Set<TopicHandler>> = new Map();

	/**
	 * Per-topic timestamp of the last mesh churn (GRAFT or PRUNE on that topic).
	 * Used as a fleet-size-agnostic mesh-stability signal: if no graft/prune has
	 * arrived for several heartbeats the gossipsub mesh is considered settled
	 * and broadcasts on that topic will reach the expected fan-out. Topic with
	 * no recorded entry has never observed a mesh event yet (mesh still
	 * forming).
	 */
	private readonly lastMeshChange: Map<string, number> = new Map();

	// Peer count change callback and debounce
	private _onPeerCountChange: ((counts: PeerCountEntry[]) => void) | null = null;
	private _peerCountDebounceTimer: NodeJS.Timeout | null = null;
	private _lastPeerCounts: Map<string, number> = new Map();
	private _lastMeshSizes: Map<string, number> = new Map();

	/**
	 * Per-network → per-bootstrap-peer dial outcome status. Outer key is
	 * networkID; inner key is the exact multiaddr string from the network
	 * config. Populated by addBootstrapPeers() when called with a networkID
	 * context (initial join + manual updates). Lets the UI surface which
	 * SPECIFIC bootstrap entry is stale (identity-mismatch) or unreachable
	 * (timeout), rather than flagging the whole network.
	 *
	 * NOT populated for dynamic bootstrap additions from peer-announce gossip
	 * (those have no single owning network and would dilute per-network stats).
	 */
	private readonly bootstrapTracker = new BootstrapStatusTracker();

	/**
	 * Ring buffer of the most recent peer disconnects. Capacity 10. Dumped at
	 * INFO level via [NET-CHURN] whenever the node drops to zero connections so
	 * we can see WHICH peers vanished right before the storm hit, instead of
	 * just observing the symptom "No connections - dialing N bootstrap peer(s)".
	 *
	 * Each entry: { ts (epoch ms), peerID (full), remaining (count after disc),
	 * wasBootstrap (whether peer was in our bootstrapPeerIDs set) }.
	 */
	private recentDisconnects: Array<{ ts: number; peerID: string; remaining: number; wasBootstrap: boolean }> = [];
	private static readonly NET_CHURN_BUFFER = 10;

	// Previous gossipsub peer scores — tracked per-peer to detect significant
	// score deltas and log threshold crossings (e.g. entered graylist).
	private _lastScores: Map<string, number> = new Map();

	/** Per-instance dedup set for PX ingress log keys; owned here, passed into gossipsub-patches deps. */
	private readonly pxIngressLogKeys = new Set<string>();

	/** Handles incoming LISH-serving pubsub messages (want, searchLishs). */
	private readonly lishHandlers: LISHServingHandlers;

	/** Manages periodic peer-announce gossip emission and inbound peer-announce handling. */
	private readonly peerAnnounce: PeerAnnounceManager;

	/**
	 * Per-peer re-dial backoff tracker. Re-dial attempts that fail bump the
	 * per-peer failCount and push nextAttempt forward exponentially (30s × 2^fails
	 * capped at 10 min), so a persistently-unreachable peer does not saturate the
	 * re-dial pool every 30s. Successful dial clears the entry.
	 */
	private readonly redialBackoff = new Map<string, { nextAttempt: number; failCount: number }>();

	// Tracked libp2p/pubsub event listeners for clean removal in stop().
	// Each entry captures the exact handler reference so removeEventListener can unhook it.
	private listeners: Array<{ target: EventTarget; event: string; handler: (evt: any) => void }> = [];

	private readonly settings: Settings;

	constructor(dataDir: string, dataServer: DataServer, settings: Settings) {
		this.dataDir = dataDir;

		this.dataServer = dataServer;
		this.settings = settings;
		this.lishHandlers = new LISHServingHandlers({
			dataServer: this.dataServer,
			lastWantResponseTime: this.lastWantResponseTime,
			seenSearchIDs: this.seenSearchIDs,
			wantResponseCooldownMs: WANT_RESPONSE_COOLDOWN_MS,
			getNode: (): Libp2p | null => this.node,
			dialByPeerId: (peerID, protocol): Promise<IDialResult> => this.dialProtocolByPeerId(peerID, protocol),
		});
		this.peerAnnounce = new PeerAnnounceManager({
			getNode: (): Libp2p | null => this.node,
			getPubsub: (): any => this.pubsub,
			broadcast: (topic, msg): Promise<void> => this.broadcast(topic, msg),
			addBootstrapPeers: (multiaddrs, networkID, origin): Promise<void> => this.addBootstrapPeers(multiaddrs, networkID, origin),
		});
	}

	/**
	 * Set a callback to be called when peer counts change for any subscribed topic.
	 */
	set onPeerCountChange(cb: ((counts: PeerCountEntry[]) => void) | null) {
		this._onPeerCountChange = cb;
	}

	/**
	 * Register an event listener on a libp2p/pubsub target and track it so it can be removed in stop().
	 * IMPORTANT: always use this helper instead of calling addEventListener() directly — otherwise
	 * the handler stays attached after stop() and holds a reference to `this` (memory leak).
	 */

	private addListener(target: EventTarget, event: string, handler: (evt: any) => void): void {
		target.addEventListener(event, handler as any);
		this.listeners.push({ target, event, handler });
	}

	/**
	 * Subscribe to libp2p `peer:connect` events for the duration of the
	 * returned disposer. The handler receives the peer ID as a string.
	 *
	 * Unlike the private `addListener`, this is intended for short-lived
	 * subscriptions tied to a specific operation (e.g. an in-flight LISH
	 * search session) — the disposer removes the listener from the global
	 * tracked-listener list so it does not leak across sessions. If the
	 * network is stopped before the caller disposes, the listener is still
	 * cleaned up via the normal {@link stop} path.
	 */
	onPeerConnect(handler: (peerID: string) => void): () => void {
		if (!this.node) return () => {};
		const node = this.node;
		const listener = (evt: any): void => {
			const pid = evt.detail?.toString?.();
			if (pid) handler(pid);
		};
		this.addListener(node, 'peer:connect', listener);
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			try {
				node.removeEventListener('peer:connect', listener as any);
			} catch {
				// Node may already be stopped — fine, stop() walked the tracked
				// list already.
			}
			const idx = this.listeners.findIndex(l => l.target === node && l.event === 'peer:connect' && l.handler === listener);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
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
	 * Check peer counts and mesh health for all subscribed topics and fire
	 * the callback if either subscriber count or mesh size has changed for
	 * any network. Both are batched into one emission so the FE never sees
	 * an inconsistent (count-without-mesh-size) snapshot.
	 */
	private checkPeerCounts(): void {
		if (!this._onPeerCountChange || !this.pubsub) return;
		const topics = this.pubsub.getTopics();
		const prefix = LISH_TOPIC_PREFIX;
		let changed = false;
		const counts: PeerCountEntry[] = [];
		for (const topic of topics) {
			if (!topic.startsWith(prefix)) continue;
			const networkID = topic.slice(prefix.length);
			let count = 0;
			try {
				count = this.pubsub.getSubscribers(topic).length;
			} catch {}
			const health = this.getMeshHealth(networkID);
			const prevCount = this._lastPeerCounts.get(networkID) ?? -1;
			const prevMesh = this._lastMeshSizes.get(networkID) ?? -1;
			if (count !== prevCount || health.meshSize !== prevMesh) changed = true;
			this._lastPeerCounts.set(networkID, count);
			this._lastMeshSizes.set(networkID, health.meshSize);
			counts.push({ networkID, count, meshSize: health.meshSize, stableSinceMs: health.stableSinceMs, medianScore: health.medianScore });
		}
		// Also detect removed topics
		const currentNetworkIDs = new Set(counts.map(c => c.networkID));
		for (const [id] of this._lastPeerCounts) {
			if (!currentNetworkIDs.has(id)) {
				this._lastPeerCounts.delete(id);
				this._lastMeshSizes.delete(id);
				changed = true;
			}
		}
		if (changed) this._onPeerCountChange(counts);
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

		const privateKey = await loadOrCreatePrivateKey(this.datastore);
		this.currentPrivateKey = privateKey;

		// Build libp2p config via extracted helper
		const {
			config,
			port,
			bootstrapPeerIDs: bootstrapPeerIDs,
			bootstrapMultiaddrs,
		} = buildLibp2pConfig({
			privateKey,
			datastore: this.datastore,
			allSettings,
			bootstrapPeers,
			myPeerID: privateKey.publicKey.toString(),
		});
		this.bootstrapPeerIDs = bootstrapPeerIDs;
		this.bootstrapMultiaddrs = bootstrapMultiaddrs;

		console.log('Creating libp2p node...');
		try {
			this.node = await createLibp2p(config);
		} catch (err: any) {
			if (err?.name === 'UnsupportedListenAddressesError' || err?.code === 'ERR_NO_VALID_ADDRESSES') {
				console.error(`✗ Failed to start network: port ${port} is likely already in use or the listen address is invalid.`);
				console.error(`  Try changing the port in settings or stop the other process using port ${port}.`);
				throw new CodedError(ErrorCodes.NETWORK_PORT_IN_USE, String(port));
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
				throw new CodedError(ErrorCodes.NETWORK_PORT_IN_USE, String(port));
			}
			throw err;
		}
		console.log('Node started');

		const addresses = this.node.getMultiaddrs();
		console.log('Listening on addresses:');
		addresses.forEach(addr => console.log('  -', addr.toString()));

		this.pubsub = this.node.services['pubsub'] as PubSub;

		// Runtime patch for @chainsafe/libp2p-gossipsub OutboundStream.push():
		// Upstream declares `async push(data)` but the body is synchronous. Any throw
		// from rawStream.send() (e.g. StreamStateError when peer disconnect closes the
		// yamux stream between gossipsub's map lookup and the actual write) becomes
		// a rejected Promise that sendRpc's try/catch cannot catch (catch handles sync
		// throws only). Those rejections are exactly the ~180/h StreamStateError noise
		// we see in unhandledRejection. Fix by attaching a .catch() to the Promise
		// returned by push() at every call site — intercept via prototype override
		// on the first OutboundStream instance we observe (all instances share one
		// prototype).
		applyGossipsubPatches(this.pubsub, { settings: this.settings, getBootstrapPeerIDs: (): Set<string> => this.bootstrapPeerIDs, pxIngressLogKeys: this.pxIngressLogKeys }, { pxIngressEnabled: allSettings.network.peerExchange.ingressFilterEnabled === true });

		// Register lish protocol handler
		await this.node.handle(
			LISH_PROTOCOL,
			async (data: any) => {
				// libp2p does NOT attach .catch() to the Promise returned by the registered
				// protocol handler. Any throw from here (including TypeError when this.node
				// is nulled by stop() racing with the 50ms await below) escapes as an
				// unhandledRejection. Wrap the full body so the handler can never leak.
				try {
					const stream = data.stream ?? data;
					const connection = data.connection;
					let remotePeerID = connection?.remotePeer?.toString?.();
					let isRelay = connection?.remoteAddr ? Circuit.matches(connection.remoteAddr) : false;
					if (!remotePeerID && this.node) {
						for (let attempt = 0; attempt < 3 && !remotePeerID; attempt++) {
							if (attempt > 0) await new Promise(r => setTimeout(r, 50));
							if (!this.node) break; // node stopped during the sleep
							for (const peer of this.node.getPeers()) {
								for (const conn of this.node.getConnections(peer)) {
									try {
										if (conn.streams.some((s: any) => s.id === stream.id)) {
											remotePeerID = peer.toString();
											isRelay = Circuit.matches(conn.remoteAddr);
										}
									} catch {}
								}
								if (remotePeerID) break;
							}
						}
					}
					const connType = remotePeerID ? classifyConnectionFn(remotePeerID, isRelay, this.dcutrPeers) : 'DIRECT';
					await handleLISHProtocol(stream, this.dataServer, remotePeerID, connType);
				} catch (err: any) {
					trace(`[NET] LISH handler error: ${err?.message ?? err}`);
				}
			},
			{ runOnLimitedConnection: true }
		);
		console.log(`✓ Registered ${LISH_PROTOCOL} protocol handler`);

		// DHT removed; only bootstrap + gossipsub for discovery

		this.addListener(this.pubsub, 'gossipsub:graft', (evt: any) => {
			trace(`[NET] GRAFT: ${evt.detail.peerID} joined ${evt.detail.topic}`);
			this.lastMeshChange.set(evt.detail.topic, Date.now());
			this.schedulePeerCountCheck();
		});

		this.addListener(this.pubsub, 'gossipsub:prune', (evt: any) => {
			trace(`[NET] PRUNE: ${evt.detail.peerID} left ${evt.detail.topic}`);
			this.lastMeshChange.set(evt.detail.topic, Date.now());
			this.schedulePeerCountCheck();
		});

		console.log('Peers in store:', this.node.getPeers().length);
		console.log('Services loaded:', Object.keys(this.node.services));

		this.setupEventListeners();
		this.setupPubsubDispatch();
		this.setupBootstrapWorkaround();
		this.setupStatusInterval();
		this.setupWantResponseCleanup();
		this.peerAnnounce.start();
	}

	// =========================================================================
	// Event listeners setup (extracted from start() for readability)
	// =========================================================================

	private setupEventListeners(): void {
		this.addListener(this.node!, 'peer:discovery', async (evt: any) => {
			const peerID = evt.detail.id.toString();
			const multiaddrs = evt.detail.multiaddrs?.map((ma: any) => ma.toString()) || [];
			trace(`[NET] Discovered peer: ${peerID}, addrs: ${multiaddrs.join(', ') || '(empty)'}`);

			// Skip if already connected (autoDial in v2 is unreliable; we dial actively
			// for mDNS/bootstrap discoveries to ensure local peers form a mesh quickly).
			if (peerID === this.node!.peerId.toString()) return;
			// Stamp `keep-alive-fleet` on every discovered peer, regardless of how they
			// surfaced (mDNS, bootstrap, autonat, identify, peer-announce). libp2p
			// ReconnectQueue only acts on peers with a tag whose key starts with
			// `keep-alive`; without it, fleet peers found via non-announce channels
			// (e.g. identify push from a common neighbour) are not re-dialed when
			// they drop. Value 50 sits between bootstrap (100) and idle (1) — protects
			// from ConnectionPruner without taking precedence over true bootstraps.
			try {
				await this.node!.peerStore.merge(evt.detail.id, {
					tags: { 'keep-alive-fleet': { value: 50 } },
				});
			} catch {
				/* ignore */
			}
			const existing = this.node!.getConnections(evt.detail.id);
			if (existing.length > 0) return;
			if (!evt.detail.multiaddrs?.length) return;

			try {
				await this.node!.dial(evt.detail.multiaddrs);
				trace(`[NET] Dialed discovered peer ${peerID.slice(0, 16)}`);
			} catch (err: any) {
				trace(`[NET] Failed to dial discovered peer ${peerID.slice(0, 16)}: ${err?.message ?? err}`);
			}
		});

		// Async listener — any rejection must be caught or it becomes unhandledRejection
		this.addListener(this.node!, 'peer:connect', async (evt: any) => {
			try {
				const peerID = evt.detail.toString();
				const connections = this.node!.getConnections(evt.detail);
				const connTypes = connections.map(c => {
					const isRelay = Circuit.matches(c.remoteAddr);
					const limited = (c as any).limits != null;
					return `${c.remoteAddr.toString()} [${isRelay ? 'RELAY' : 'DIRECT'}${limited ? ',LIMITED' : ''}${c.direction}]`;
				});
				console.debug(`✅ Peer connected: ${peerID.slice(0, 16)}`);
				console.debug(`   Connections (${connections.length}): ${connTypes.join(' | ')}`);
				console.debug(`   Total connected: ${this.node!.getPeers().length}`);

				if (this.bootstrapPeerIDs.has(peerID)) {
					const connectionMultiaddrs = connections.map(c => c.remoteAddr);
					await this.node!.peerStore.merge(evt.detail, {
						multiaddrs: connectionMultiaddrs,
						tags: { [KEEP_ALIVE]: { value: 1 } },
					});
					console.debug('   Tagged as KEEP_ALIVE (bootstrap peer)');
				}
				this.schedulePeerCountCheck();
			} catch (err: any) {
				trace(`[NET] peer:connect handler error: ${err?.message ?? err}`);
			}
		});

		this.addListener(this.node!, 'peer:disconnect', (evt: any) => {
			const peerID = evt.detail.toString();
			const remaining = this.node!.getPeers().length;
			const wasBootstrap = this.bootstrapPeerIDs.has(peerID);
			console.debug(`❌ Peer disconnected: ${peerID.slice(0, 16)}, remaining: ${remaining}`);
			// Push into churn ring buffer; trim to capacity. Used by [NET-CHURN] dump
			// when getConnections() hits zero so we can see who left right before the storm.
			this.recentDisconnects.push({ ts: Date.now(), peerID, remaining, wasBootstrap });
			if (this.recentDisconnects.length > Network.NET_CHURN_BUFFER) this.recentDisconnects.shift();
			trace(`[NET-DISC] peer=${peerID.slice(0, 16)} remaining=${remaining} bootstrap=${wasBootstrap}`);
			// Fix C: clear per-peer state on disconnect to prevent unbounded growth
			this.dcutrPeers.delete(peerID);
			// `@chainsafe/libp2p-gossipsub` v14 removes the peer from `this.mesh`
			// directly inside `removePeer()` on disconnect — without emitting a
			// `gossipsub:prune` event (verified in node_modules/.../gossipsub.js:
			// `removePeer` block deletes from `this.mesh` then `this.fanout`,
			// only emit-paths are explicit PRUNE control messages). Without
			// stamping `lastMeshChange` here the FE would keep `stableSinceMs`
			// climbing while the mesh was actually churned by the disconnect.
			// The peer may not have been a mesh member of every subscribed
			// topic, but a disconnect can still trigger heartbeat reshuffles
			// across all of them, so refresh every LISH topic's timestamp as
			// a safe upper bound.
			if (this.pubsub) {
				const now = Date.now();
				for (const topic of this.pubsub.getTopics()) {
					if (topic.startsWith(LISH_TOPIC_PREFIX)) this.lastMeshChange.set(topic, now);
				}
			}
			this.schedulePeerCountCheck();
		});

		this.addListener(this.node!, 'relay:created-reservation', (evt: any) => {
			console.log(`[NET] 🔄 Relay reservation CREATED with: ${evt.detail?.relay?.toString?.() ?? 'unknown'}`);
		});
		this.addListener(this.node!, 'relay:removed', (evt: any) => {
			console.log(`[NET] ⚠️  Relay removed: ${evt.detail?.relay?.toString?.() ?? 'unknown'}`);
		});
		// Surface reservation failures — silent failures are why NAT'd peers can't
		// be reached by siblings (no /p2p-circuit announceable without reservation).
		this.addListener(this.node!, 'relay:reservation:failed' as any, (evt: any) => {
			console.log(`[NET] ❌ Relay reservation FAILED: ${evt.detail?.relay?.toString?.() ?? 'unknown'} err=${evt.detail?.error?.message ?? ''}`);
		});
		this.addListener(this.node!, 'relay:reservation:expired' as any, (evt: any) => {
			console.log(`[NET] ⏰ Relay reservation EXPIRED: ${evt.detail?.relay?.toString?.() ?? 'unknown'}`);
		});
		// Surface self-dial events — when we try to dial a peer, log which transport type is used
		this.addListener(this.node!, 'peer:connect' as any, (evt: any) => {
			const peerID = evt.detail?.toString?.() ?? '';
			if (this.bootstrapPeerIDs.has(peerID)) return; // skip bootstrap noise
			console.log(`[NET] 🔗 peer:connect ${peerID.slice(0, 16)}`);
		});

		// DCUtR hole punch events
		this.addListener(this.node!, 'dcutr:success', (evt: any) => {
			const peer = evt.detail?.remotePeer?.toString?.();
			if (peer) this.dcutrPeers.add(peer);
			console.log(`[NET] DCUtR hole punch SUCCESS: ${peer?.slice(0, 16) ?? 'unknown'}, dcutrPeers=[${[...this.dcutrPeers].map(p => p.slice(0, 12)).join(',')}]`);
		});
		this.addListener(this.node!, 'dcutr:error', (evt: any) => {
			console.debug(`[NET] DCUtR hole punch FAILED: ${evt.detail?.remotePeer?.toString?.()?.slice(0, 16) ?? 'unknown'} — ${evt.detail?.error?.message ?? 'unknown error'}`);
		});

		// Connection close/abort events for relay debugging
		this.addListener(this.node!, 'connection:close', (evt: any) => {
			const conn = evt.detail;
			if (conn?.remoteAddr && Circuit.matches(conn.remoteAddr)) {
				trace(`[NET] Relay connection closed: ${conn.remotePeer?.toString?.()?.slice(0, 16)} addr=${conn.remoteAddr.toString()}`);
			}
		});
	}

	private setupPubsubDispatch(): void {
		this.addListener(this.pubsub!, 'message', (evt: any) => {
			this.handleMessage(evt.detail);
		});
	}

	/**
	 * Periodically prune lastWantResponseTime entries older than the cooldown window.
	 * Entries past the cooldown have no effect (next want would pass anyway), so dropping them
	 * keeps the map bounded over long-running sessions even with churn of remote peers.
	 */
	private setupWantResponseCleanup(): void {
		this.wantResponseCleanupInterval = setInterval(() => {
			const cutoff = Date.now() - WANT_RESPONSE_COOLDOWN_MS;
			let removed = 0;
			for (const [key, ts] of this.lastWantResponseTime) {
				if (ts < cutoff) {
					this.lastWantResponseTime.delete(key);
					removed++;
				}
			}
			if (removed > 0) trace(`[NET] want-response cooldown cleanup: pruned ${removed}, kept ${this.lastWantResponseTime.size}`);
			const searchCutoff = Date.now() - SEARCH_DEDUP_TTL_MS;
			let searchRemoved = 0;
			for (const [key, ts] of this.seenSearchIDs) {
				if (ts < searchCutoff) {
					this.seenSearchIDs.delete(key);
					searchRemoved++;
				}
			}
			if (searchRemoved > 0) trace(`[NET] search-dedup cleanup: pruned ${searchRemoved}, kept ${this.seenSearchIDs.size}`);
		}, WANT_RESPONSE_CLEANUP_INTERVAL_MS);
	}

	private setupBootstrapWorkaround(): void {
		if (!AUTODIAL_WORKAROUND || this.bootstrapMultiaddrs.length === 0) return;
		// setTimeout discards the Promise returned by async callbacks, so throws escape
		// as unhandledRejection. Plus this.node can be null if stop() fires within 2s.
		// Null-check at entry, wrap inner async work, attach .catch() to surface errors.
		setTimeout(() => {
			if (!this.node || this.node.getPeers().length > 0) return;
			(async () => {
				console.log('⚠️  Bootstrap module failed - dialing directly...');
				for (const ma of this.bootstrapMultiaddrs) {
					if (!this.node) break;
					try {
						await this.node.dial(ma);
						console.log('✓ Connected to bootstrap peer via direct dial');
						break;
					} catch (err: any) {
						console.log('✗ Direct dial failed:', err.message);
					}
				}
			})().catch(err => trace(`[NET] bootstrapWorkaround error: ${err?.message ?? err}`));
		}, 2000);
	}

	private setupStatusInterval(): void {
		this.statusInterval = setInterval(async () => {
			try {
				const connectedPeers = this.node!.getPeers();
				const allPeers = await this.node!.peerStore.all();
				logStatusDebug({ node: this.node, pubsub: this.pubsub, settings: this.settings, lastScores: this._lastScores }, connectedPeers, allPeers);
				dumpGossipsubScores({ node: this.node, pubsub: this.pubsub, settings: this.settings, lastScores: this._lastScores }, connectedPeers);
				// Periodic peer count refresh — catches cases where GRAFT/PRUNE events were missed
				this.checkPeerCounts();
				await this.runRedialMaintenance(connectedPeers, allPeers);
				await this.runZeroConnectionRecovery(connectedPeers);
				await this.maybePromotePeers();
			} catch (err: any) {
				trace(`[NET] statusInterval error: ${err?.message ?? err}`);
			}
		}, 30000);
		// Status interval 30 s. promoteKnownPeersToBootstrap + gossipsub.direct
		// mutations run on the 5th tick (~150 s) — fast enough to absorb peer
		// churn at N≈100 without flooding logs or burning CPU on per-second probes.
	}

	private async runRedialMaintenance(connectedPeers: any[], allPeers: any[]): Promise<void> {
		// Dial known peers not currently connected (maintains relay connections to NATed peers)
		const connectedSet = new Set(connectedPeers.map(p => p.toString()));
		const now = Date.now();
		// Build candidate list: all known peers that are (a) not connected, and
		// (b) past their backoff window. Bootstrap peers are included so a bootstrap
		// that drops comes back quickly without needing connectedPeers.length===0.
		const candidates: Array<{ peer: any; pid: string; addrSummary: string; failCount: number }> = [];
		let skippedBackoff = 0;
		let skippedNoReachable = 0;
		const localCidrs = getLocalCidrs(now);
		for (const peer of allPeers) {
			const pid = peer.id.toString();
			if (connectedSet.has(pid)) {
				this.redialBackoff.delete(pid); // clear on observed connection
				continue;
			}
			const bo = this.redialBackoff.get(pid);
			if (bo && bo.nextAttempt > now) {
				skippedBackoff++;
				continue;
			}
			// Pre-filter peerStore multiaddrs through the dial gater. If every
			// known address is unreachable from this node (e.g. only LAN addrs
			// of a foreign subnet), skip the dial entirely — otherwise libp2p
			// returns "no valid addresses" after still spending a slot on us.
			const entries = peer.addresses ?? [];
			const reachable: string[] = [];
			for (const a of entries) {
				const ma = a?.multiaddr;
				if (!ma) continue;
				if (!shouldDenyDial(ma, localCidrs)) reachable.push(ma.toString());
			}
			if (reachable.length === 0) {
				skippedNoReachable++;
				continue;
			}
			candidates.push({ peer, pid, addrSummary: reachable.join(' | '), failCount: bo?.failCount ?? 0 });
		}
		// Parallel dial with concurrency=10 via rolling promise pool; caps worst-case
		// tick latency at ~5s × ceil(N/10) instead of 5s × N for pre-throttle code.
		const CONCURRENCY = 10;
		let redialSuccess = 0;
		let idx = 0;
		const worker = async (): Promise<void> => {
			while (idx < candidates.length) {
				const c = candidates[idx++]!;
				console.debug(`   ↻ Re-dial attempt peer=${c.pid} addrs=${c.addrSummary} fails=${c.failCount}`);
				try {
					await this.node!.dial(c.peer.id, { signal: AbortSignal.timeout(5000) });
					const conns = this.node!.getConnections(c.peer.id);
					const connDetail = conns
						.map(conn => {
							const ra = conn.remoteAddr?.toString?.() ?? '?';
							const type = Circuit.matches(conn.remoteAddr) ? 'RELAY' : 'DIRECT';
							return `${type}(${ra})`;
						})
						.join(',');
					console.debug(`   ✓ Re-dialed peer=${c.pid} via=${connDetail || '(no conn info)'}`);
					this.redialBackoff.delete(c.pid);
					redialSuccess++;
					// Re-stamp keep-alive-fleet on every successful re-dial so
					// ReconnectQueue will fire if this peer drops again. Peers may
					// have lost the tag through peerStore cleanup
					// (maxAddressAge/maxPeerAge) between earlier tagging events.
					try {
						await this.node!.peerStore.merge(c.peer.id, {
							tags: { 'keep-alive-fleet': { value: 50 } },
						});
					} catch {
						/* non-fatal */
					}
				} catch (err: any) {
					// Exponential backoff: 30s × 2^failCount, capped at 10 min.
					const nextFailCount = c.failCount + 1;
					const delayMs = Math.min(30_000 * 2 ** c.failCount, 600_000);
					this.redialBackoff.set(c.pid, { nextAttempt: Date.now() + delayMs, failCount: nextFailCount });
					console.debug(`   ✗ Re-dial peer=${c.pid} failed: ${err.message ?? err} (tried: ${c.addrSummary}, next in ${Math.round(delayMs / 1000)}s)`);
				}
			}
		};
		const workers = Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker());
		await Promise.all(workers);
		if (candidates.length > 0 || skippedBackoff > 0 || skippedNoReachable > 0) {
			console.debug(`   Re-dial: ${redialSuccess}/${candidates.length} succeeded (${skippedBackoff} skipped by backoff, ${skippedNoReachable} skipped no-reachable-addrs)`);
		}
		// Prune backoff entries for peers that are no longer in peerStore to prevent unbounded growth.
		const storeSet = new Set(allPeers.map(p => p.id.toString()));
		for (const pid of this.redialBackoff.keys()) if (!storeSet.has(pid)) this.redialBackoff.delete(pid);
	}

	private async runZeroConnectionRecovery(connectedPeers: any[]): Promise<void> {
		if (!AUTODIAL_WORKAROUND || connectedPeers.length !== 0 || this.bootstrapMultiaddrs.length === 0) return;
		console.log(`   ⚠️  No connections - dialing ${this.bootstrapMultiaddrs.length} bootstrap peer(s) directly...`);
		// [NET-CHURN] dump: who left in the run-up to this zero-connection
		// state, and what each configured bootstrap entry's last dial outcome
		// was. Without this we only ever see the recovery dial — never the cause.
		if (this.recentDisconnects.length > 0) {
			const now = Date.now();
			const summary = this.recentDisconnects.map(d => `${d.peerID.slice(0, 16)}(${Math.round((now - d.ts) / 1000)}s${d.wasBootstrap ? ',BS' : ''})`).join(' ');
			console.log(`   [NET-CHURN] last ${this.recentDisconnects.length} disconnects: ${summary}`);
		} else {
			console.log(`   [NET-CHURN] no disconnects recorded — autodial fired without any peer:disconnect event (libp2p internal eviction?)`);
		}
		for (const [networkID, peers] of this.bootstrapTracker.entries()) {
			const counts: Record<string, number> = {};
			for (const p of peers.values()) counts[p.status] = (counts[p.status] ?? 0) + 1;
			const parts = Object.entries(counts)
				.map(([k, v]) => `${k}=${v}`)
				.join(' ');
			console.log(`   [NET-CHURN] bootstrap stats net=${networkID.slice(0, 8)}: ${parts}`);
		}
		for (const ma of this.bootstrapMultiaddrs) {
			const maStr = ma?.toString?.() ?? String(ma);
			try {
				console.log(`   → Dialing ${maStr}`);
				await this.node!.dial(ma, { signal: AbortSignal.timeout(10000) });
				console.log(`   ✓ Connected via ${maStr}`);
				break;
			} catch (err: any) {
				console.log(`   ✗ Failed ${maStr}: ${err.message ?? err}`);
			}
		}
	}

	private async maybePromotePeers(): Promise<void> {
		// Every 5th status tick (~150 s at 30 s status cadence) promote every
		// peerStore entry back to bootstrap priority. Re-stamps KEEP_ALIVE tags
		// and feeds libp2p a concrete multiaddr list to re-dial against, catching
		// peers whose original dial cached a stale (unreachable) address — these
		// would otherwise sit idle until they reappeared via identify/PX/announce.
		this.statusTickCount++;
		if (this.statusTickCount % 5 === 0) {
			try {
				await this.promoteKnownPeersToBootstrap();
			} catch (err: any) {
				trace(`[NET] promoteKnownPeersToBootstrap failed: ${err?.message ?? err}`);
			}
		}
	}

	/**
	 * Promote every known peer (from libp2p peerStore) back to bootstrap priority so
	 * KEEP_ALIVE tagging and direct-dial re-runs cover peers the ordinary re-dial loop
	 * skipped because their cached multiaddrs looked like loopback/private-IP garbage.
	 * Runs every ~45 s from the status tick.
	 */
	private async promoteKnownPeersToBootstrap(): Promise<void> {
		if (!this.node) return;
		const allPeers = await this.node.peerStore.all();
		const myID = this.node.peerId.toString();
		const maStrings: string[] = [];
		for (const peer of allPeers) {
			const pid = peer.id.toString();
			if (pid === myID) continue;
			if (this.bootstrapPeerIDs.has(pid)) continue;
			if (peer.addresses.length === 0) continue;
			const addr = peer.addresses[0]!;
			const base = addr.multiaddr.toString();
			// Ensure /p2p/<id> suffix — addBootstrapPeers extracts peer ID via multiaddr component 421.
			const maStr = base.includes('/p2p/') ? base : `${base}/p2p/${pid}`;
			maStrings.push(maStr);
		}
		if (maStrings.length === 0) return;
		trace(`[NET] periodic autodial: promoting ${maStrings.length} peer(s) to bootstrap`);
		await this.addBootstrapPeers(maStrings);
		// Also insert every known peer into the gossipsub `direct` Set at runtime.
		// Direct peers are never PRUNED by D/Dhi and have their own fast reconnect
		// cadence (directConnectTicks × heartbeatInterval). KEEP_ALIVE handles the
		// TCP layer; gossipsub.direct handles the gossipsub-stream layer.
		const gossipsub: any = this.pubsub;
		if (gossipsub?.direct && typeof gossipsub.direct.add === 'function') {
			let added = 0;
			for (const peer of allPeers) {
				const pid = peer.id.toString();
				if (pid === myID) continue;
				if (!gossipsub.direct.has(pid)) {
					gossipsub.direct.add(pid);
					added++;
				}
			}
			if (added > 0) trace(`[NET] gossipsub direct: added ${added} known peer(s) to never-PRUNE set`);
		}
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
	 * Get the underlying libp2p node (for low-level event listening / stats).
	 * Returns null if node has not been started yet.
	 */
	getNode(): any {
		return this.node;
	}

	/**
	 * Add bootstrap peers dynamically to the running node.
	 * Dials them directly since the bootstrap module only works at config time.
	 *
	 * When `networkID` is provided, dial outcomes are recorded into per-network
	 * bootstrap status counters (used by the UI to surface stale-config warnings).
	 * Pass `null` for dynamic additions that have no single owning network
	 * (e.g. peer-announce gossip), in which case stats are skipped.
	 */
	async addBootstrapPeers(peers: string[], networkID: string | null = null, origin: BootstrapPeerOrigin = 'discovered'): Promise<void> {
		if (!this.node) {
			console.error('Network not started - cannot add bootstrap peers');
			return;
		}
		const myPeerID = this.node.peerId.toString();
		const localCidrs = getLocalCidrs();
		for (const peer of peers) {
			// Skip our own address
			if (peer.includes(myPeerID)) continue;
			try {
				const ma = Multiaddr(peer);
				// Safety net: refuse to add loopback / unreachable-private bootstrap
				// entries even if the upstream (catalog or peer-announce intake)
				// failed to filter them. Failing here is silent because the call
				// site iterates many candidates and we shouldn't spam INFO for
				// every drop; trace-level keeps it greppable when debugging.
				if (shouldDenyDial(ma, localCidrs)) {
					trace(`[NET] addBootstrapPeers skip non-routable: ${peer}`);
					continue;
				}
				const peerID = ma.getComponents().find(c => c.code === 421)?.value ?? null;
				const alreadyKnown = !!peerID && this.bootstrapPeerIDs.has(peerID);
				if (peerID && !alreadyKnown) {
					this.bootstrapPeerIDs.add(peerID);
					this.bootstrapMultiaddrs.push(ma);
				}
				console.debug('Adding bootstrap peer:', peer);
				this.bootstrapTracker.markPending(networkID, peer, peerID, origin);
				try {
					// Skip re-dialing when libp2p already has an active connection to this peer
					// (typical when the same bootstrap entry appears in multiple lishnets).
					// We still record the outcome so per-network status reflects "connected"
					// rather than leaving the entry stuck at "pending".
					const reuseExisting = alreadyKnown && peerID && this.node.getConnections(peerIDFromString(peerID)).length > 0;
					if (!reuseExisting) await this.node.dial(ma);
					if (peerID) {
						await this.node.peerStore.merge(peerIDFromString(peerID), {
							multiaddrs: [ma],
							tags: { [KEEP_ALIVE]: { value: 1 } },
						});
					}
					this.bootstrapTracker.recordOutcome(networkID, peer, peerID, 'connected', null, null, origin);
					console.log('✓ Connected to new bootstrap peer');
				} catch (err: any) {
					const message = err?.message ?? String(err);
					const kind = classifyBootstrapError(message);
					const actualPeerID = kind === 'identity-mismatch' ? extractActualPeerID(message) : null;
					this.bootstrapTracker.recordOutcome(networkID, peer, peerID, kind, message, actualPeerID, origin);
					// [NET-MISMATCH] richer log for identity-mismatch — single line containing
					// origin (configured / discovered from peer-announce), multiaddr,
					// expected peerID and the actual peerID Noise reported. Makes it
					// trivial to grep `[NET-MISMATCH]` and diff what the catalog has
					// vs reality, even before the UI shows the same data.
					if (kind === 'identity-mismatch') {
						console.log(`[NET-MISMATCH] origin=${origin} net=${networkID?.slice(0, 8) ?? 'none'} addr=${peer} expected=${peerID ?? 'none'} actual=${actualPeerID ?? 'unparsed'}`);
					} else {
						console.log(`⚠️  Could not connect to bootstrap peer (${kind}): ${peer} — ${message}`);
					}
					// Crypto-verified identity mismatch ⇒ peerID stored in our peerStore
					// is provably wrong for this address. Purge it so libp2p autodial
					// stops retrying the dead identity. Safe because Noise handshake
					// is unforgeable — a mismatch is definitive, never a transient
					// network issue. Only triggers when we have an expected peerID
					// to purge.
					if (kind === 'identity-mismatch' && peerID) {
						await this.purgeStalePeer(peerID, `${origin} dial identity mismatch`);
						// For DISCOVERED entries (peer-announce gossip), also drop the
						// status entry — there's no saved config row to "fix" and leaving
						// it visible just adds UI noise. For CONFIGURED entries, keep
						// it so the user can decide to update or remove the saved row.
						if (origin === 'discovered' && networkID) {
							this.bootstrapTracker.deletePeer(networkID, peer);
						}
					}
				}
			} catch (error: any) {
				this.bootstrapTracker.recordOutcome(networkID, peer, null, 'error', error?.message ?? String(error), null, origin);
				console.log('⚠️  Skipping invalid multiaddr:', peer, '-', error.message);
			}
		}
	}

	/**
	 * Set a callback for per-network bootstrap status updates. Called whenever
	 * `addBootstrapPeers(_, networkID)` records a new outcome for any entry.
	 */
	set onBootstrapStatusChange(cb: ((networkID: string, status: BootstrapStatus) => void) | null) {
		this.bootstrapTracker.setOnChange(cb);
	}

	/**
	 * Remove a peerID from libp2p's peerStore + drop it from our bootstrap dedup set.
	 *
	 * Called when we have crypto-strong evidence the stored identity is wrong
	 * (Noise handshake reported a different peerID than the multiaddr's `/p2p/<id>`
	 * suffix claimed). Removing the entry stops libp2p ReconnectQueue / autodial
	 * from re-attempting the dead identity.
	 *
	 * Best-effort: a peerStore.delete failure is logged at debug but does not throw —
	 * the same peer will be re-purged next cycle if libp2p keeps trying it.
	 */
	async purgeStalePeer(peerID: string, reason: string): Promise<void> {
		if (!this.node) return;
		this.bootstrapPeerIDs.delete(peerID);
		try {
			const pid = peerIDFromString(peerID);
			// Drop existing connections so libp2p considers the entry fully gone.
			const conns = this.node.getConnections(pid);
			for (const c of conns) {
				try {
					await c.close();
				} catch {
					/* connection may already be closing */
				}
			}
			await this.node.peerStore.delete(pid);
			console.log(`[NET] purged stale peerStore entry ${peerID.slice(0, 16)}… (reason: ${reason})`);
		} catch (err: any) {
			trace(`[NET] purgeStalePeer ${peerID.slice(0, 16)} failed: ${err?.message ?? err}`);
		}
	}

	/** Snapshot of all per-network bootstrap statuses. */
	getAllBootstrapStatuses(): BootstrapStatus[] {
		return this.bootstrapTracker.getAllStatuses();
	}

	/** Snapshot of a single network's bootstrap status, or null if no attempts have been recorded. */
	getBootstrapStatus(networkID: string): BootstrapStatus | null {
		return this.bootstrapTracker.getStatus(networkID);
	}

	/** Drop bootstrap status entries no longer in the configured peer list (after an update). */
	pruneBootstrapStatus(networkID: string, keepMultiaddrs: string[]): void {
		this.bootstrapTracker.pruneEntries(networkID, keepMultiaddrs);
	}

	/** Reset the bootstrap status for a single network (used when re-joining). */
	resetBootstrapStatus(networkID: string): void {
		this.bootstrapTracker.resetNetwork(networkID);
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
		// Register per-topic score parameters so gossipsub can measure peer behaviour
		// (P1 timeInMesh, P2 firstMessageDeliveries, P4 invalidMessageDeliveries) for
		// this topic. Without this, per-topic score is always 0 → acceptPXThreshold
		// unreachable for non-bootstrap peers → PX limited to bootstrap-sourced peers only.
		// P3 (meshMessageDeliveries) intentionally disabled: false-positive killer in
		// low-traffic topics per Ethereum consensus research.
		const scoreSvc = (this.pubsub as any).score;
		if (scoreSvc?.params?.topics) {
			// Use createTopicScoreParams() helper from gossipsub: it merges our overrides
			// onto defaultTopicScoreParams. This guarantees every numeric field is defined
			// (including any new fields a future library upgrade may add), preventing the
			// `0 * undefined = NaN` propagation in PeerScore.refreshScores() that
			// previously surfaced as NaN per-peer scores → silent exclusion from
			// gossipsub floodPublish (NaN >= publishThreshold === false in JS).
			scoreSvc.params.topics[topic] = createTopicScoreParams({
				topicWeight: 0.5,
				timeInMeshWeight: 0.01,
				timeInMeshQuantum: 1000,
				timeInMeshCap: 300,
				firstMessageDeliveriesWeight: 0.5,
				firstMessageDeliveriesDecay: 0.998,
				firstMessageDeliveriesCap: 100,
				// P3 (meshMessageDeliveries) and P3b (meshFailurePenalty) intentionally
				// disabled via weight=0 — defaults supply finite numbers for the related
				// decay/cap/threshold/activation/window fields so the unused arithmetic
				// in refreshScores still yields 0 instead of NaN.
				meshMessageDeliveriesWeight: 0,
				meshFailurePenaltyWeight: 0,
				// invalidMessageDeliveriesWeight tuned to -5 (default would be -1, but
				// even -1 multiplied by topicWeight=0.5 plus quadratic invalidMessages²
				// quickly produces -320 scores that graylist half the fleet after every
				// coordinated restart. Invalid messages during warmup are frequently
				// caused by signature races at peer:connect, not malicious publishers —
				// the severe default penalty is inappropriate for trusted-fleet setups.
				invalidMessageDeliveriesWeight: -5,
				invalidMessageDeliveriesDecay: 0.9,
			});
			console.log(`[NET] gossipsub score registered for ${topic}`);
		} else {
			trace(`[NET] gossipsub score service not available for ${topic}`);
		}
		// Register the Want handler for this network. TopicHandler is sync (returns void) but
		// handleWant is async — a rejection from any async operation inside it (dial failure,
		// CodedError from closed stream, etc.) would otherwise propagate as unhandledRejection.
		// Catch here so the pubsub dispatch loop remains isolated from per-handler failures.
		const handler: TopicHandler = (data, from): void => {
			trace(`[NET] pubsub ${topic}: ${data['type']}`);
			if (data['type'] === 'want') {
				this.lishHandlers.handleWant(data as WantMessage, networkID, from).catch(err => {
					trace(`[NET] handleWant failed: ${err?.message ?? err}`);
				});
			} else if (data['type'] === 'peer-announce') {
				this.peerAnnounce.handle(data as unknown as PeerAnnounceMessage, networkID, from).catch(err => {
					trace(`[NET] handlePeerAnnounce failed: ${err?.message ?? err}`);
				});
			} else if (data['type'] === 'searchLishs') {
				this.lishHandlers.handleSearchLishs(data as SearchLishsMessage, networkID, from).catch(err => {
					trace(`[NET] handleSearchLishs failed: ${err?.message ?? err}`);
				});
			}
		};
		if (!this.topicHandlers.has(topic)) this.topicHandlers.set(topic, new Set());
		this.topicHandlers.get(topic)!.add(handler);
		console.log(`✓ Subscribed to lishnet topic: ${topic}`);
		// GossipSub mesh needs time to rebuild after subscribe — schedule delayed peer count checks
		setTimeout(() => this.schedulePeerCountCheck(), 2000);
		setTimeout(() => this.schedulePeerCountCheck(), 5000);
		setTimeout(() => this.schedulePeerCountCheck(), 15000);
	}

	/**
	 * Unsubscribe from a lishnet topic.
	 */
	unsubscribeHandler(topic: string, handler: TopicHandler): void {
		const handlers = this.topicHandlers.get(topic);
		if (handlers) handlers.delete(handler);
	}

	unsubscribeTopic(networkID: string): void {
		if (!this.pubsub) return;
		const topic = lishTopic(networkID);
		this.pubsub.unsubscribe(topic);
		this.topicHandlers.delete(topic);
		console.log(`✓ Unsubscribed from lishnet topic: ${topic}`);
		this.schedulePeerCountCheck();
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
	 * Snapshot of fleet-size-agnostic mesh health for a network's gossipsub topic.
	 *
	 * - `meshSize` — count of peers currently in the gossipsub topic mesh
	 *   (`pubsub.mesh[topic]`). 0 means we have no full-mesh peers and broadcasts
	 *   on this topic will not be delivered (only gossiped).
	 * - `stableSinceMs` — milliseconds elapsed since the last GRAFT or PRUNE on
	 *   this topic. The gossipsub heartbeat interval is 1 s; staying silent for
	 *   several heartbeats (≥ 5 s in practice) means the heartbeat algorithm
	 *   considers the mesh size settled within `[D_low, D_high]`. Returns
	 *   `Number.POSITIVE_INFINITY` while no event has been observed yet — the
	 *   caller should treat this as "unknown" and combine with `meshSize === 0`
	 *   to distinguish "freshly subscribed" from "long-quiet steady state".
	 * - `medianScore` — median of `pubsub.score.score(peerID)` across mesh peers,
	 *   or `null` when the mesh is empty. Spec defines score 0 as the baseline
	 *   for staying in the mesh; positive median = healthy, negative median =
	 *   the heartbeat will start pruning peers and the router may opportunistic-
	 *   graft. Median (not mean) so a single sybil cannot skew the indicator.
	 *
	 * The signal is intentionally relative — no absolute peer count is required
	 * to interpret it, so the same logic works for a 3-peer LAN and a 300-peer
	 * fleet.
	 */
	getMeshHealth(networkID: string): IMeshHealth {
		const empty: IMeshHealth = { meshSize: 0, stableSinceMs: null, medianScore: null };
		if (!this.pubsub) return empty;
		const topic = lishTopic(networkID);
		// `mesh` and `score` are declared `readonly public` on `GossipSub`
		// (see gossipsub.d.ts:50,102). The libp2p `PubSub` interface used as
		// the field type here doesn't surface them, so a narrow structural
		// cast keeps the access typed without a blanket `any`.
		const gs = this.pubsub as unknown as { mesh?: Map<string, Set<string>>; score?: { score(peerID: string): number } };
		const meshPeerSet = gs.mesh?.get(topic);
		const meshPeers = meshPeerSet ? [...meshPeerSet] : [];
		const last = this.lastMeshChange.get(topic);
		// `null` means "no graft/prune ever observed on this topic" — distinct
		// from "0 ms since last change". Sent over the wire because JSON has no
		// Infinity; the FE treats null as "stability unknown / still forming".
		const stableSinceMs = last === undefined ? null : Math.max(0, Date.now() - last);
		let medianScore: number | null = null;
		if (meshPeers.length > 0 && typeof gs.score?.score === 'function') {
			const scores: number[] = [];
			for (const p of meshPeers) {
				try {
					const s = Number(gs.score.score(p));
					if (Number.isFinite(s)) scores.push(s);
				} catch {
					// Score lookup may throw for peers in transitional states; skip.
				}
			}
			if (scores.length > 0) {
				scores.sort((a, b) => a - b);
				const n = scores.length;
				// True statistical median: average the two middle values for
				// even N. Picking the upper middle silently rounded a half-
				// graylisted mesh (e.g. `[-100, 0]` → 0 → "stable") into the
				// healthy bucket — a single positive outlier could mask a peer
				// the heartbeat is about to PRUNE.
				medianScore = n % 2 === 0 ? (scores[n / 2 - 1]! + scores[n / 2]!) / 2 : (scores[Math.floor(n / 2)] ?? null);
			}
		}
		return { meshSize: meshPeers.length, stableSinceMs, medianScore };
	}

	// =========================================================================
	// Pubsub dispatch
	// =========================================================================

	private async handleMessage(msgEvent: PubsubEvent): Promise<void> {
		try {
			const topic = msgEvent.topic;
			// Reject oversize payloads before decoding — cheap DoS guard.
			// All our pubsub messages are small JSON control frames; anything larger is either
			// a bug or hostile.
			if (msgEvent.data.byteLength > MAX_PUBSUB_PAYLOAD_BYTES) {
				const from = msgEvent.from?.toString().slice(0, 12) ?? 'unknown';
				console.warn(`[NET] pubsub ${topic} payload too large: ${msgEvent.data.byteLength}B from ${from} (max ${MAX_PUBSUB_PAYLOAD_BYTES}B), dropped`);
				return;
			}
			const data = new TextDecoder().decode(msgEvent.data);
			const message = JSON.parse(data);
			const from = msgEvent.from?.toString();

			// Dispatch to registered topic handlers
			const handlers = this.topicHandlers.get(topic);
			if (handlers) for (const handler of handlers) await handler(message, from);
		} catch (error) {
			console.error('Error in handleMessage:', error);
		}
	}

	// =========================================================================
	// Public API
	// =========================================================================

	async broadcast(topic: string, data: Record<string, any>): Promise<void> {
		if (!this.pubsub || !this.node) {
			console.error('Network not started');
			return;
		}
		trace(`[NET] broadcast ${topic}: ${data['type']}`);
		const encoded = new TextEncoder().encode(JSON.stringify(data));
		const result = await this.pubsub.publish(topic, encoded);
		const recips = (result as any)?.recipients?.map((p: any) => p.toString().slice(0, 12)) ?? [];
		trace(`[NET] broadcast ${topic.slice(0, 28)}: ${data['type']} → recipients=[${recips.join(',')}] count=${recips.length}`);
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
		console.debug(`Subscribed to topic: ${topic}`);
	}

	async connectToPeer(multiaddr: string): Promise<void> {
		if (!this.node) throw new CodedError(ErrorCodes.NETWORK_NOT_STARTED);
		await connectToPeerFn(this.node, multiaddr);
	}

	async dialProtocol(multiaddrs: any[], protocol: string): Promise<IDialResult> {
		if (!this.node) throw new CodedError(ErrorCodes.NETWORK_NOT_STARTED);
		return dialProtocolFn(this.node, this.dcutrPeers, multiaddrs, protocol);
	}

	async dialProtocolByPeerId(peerID: string, protocol: string): Promise<IDialResult> {
		if (!this.node) throw new CodedError(ErrorCodes.NETWORK_NOT_STARTED);
		return dialProtocolByPeerIdFn(this.node, this.dcutrPeers, peerID, protocol);
	}

	/**
	 * Get node info (peerID, addresses).
	 */
	getNodeInfo(): NetworkNodeInfo | null {
		if (!this.node) return null;
		return {
			peerID: this.node.peerId.toString(),
			addresses: this.node.getMultiaddrs().map((ma: any) => ma.toString()),
		};
	}

	/**
	 * Read the current identity (peer ID + private key in libp2p protobuf format).
	 * Works while the network is running (reads from in-memory node).
	 * Returns null if the node is not running.
	 */
	exportIdentity(): IExportedIdentity | null {
		if (!this.node || !this.currentPrivateKey) return null;
		const bytes = privateKeyToProtobuf(this.currentPrivateKey);
		return { peerID: this.node.peerId.toString(), privateKeyBytes: bytes };
	}

	/**
	 * Write a new identity private key into the datastore. The network must be stopped.
	 * Validates the protobuf bytes by attempting to decode them.
	 */
	async writeIdentityKey(privateKeyBytes: Uint8Array): Promise<void> {
		if (this.node) throw new CodedError(ErrorCodes.INTERNAL_ERROR, 'Network must be stopped before writing identity key');
		await writeIdentityKeyToDatastore(this.dataDir, privateKeyBytes);
	}

	/**
	 * Delete the identity private key from the datastore. The network must be stopped.
	 * Next start will generate a fresh key.
	 */
	async clearIdentityKey(): Promise<void> {
		if (this.node) throw new CodedError(ErrorCodes.INTERNAL_ERROR, 'Network must be stopped before clearing identity key');
		await clearIdentityKeyFromDatastore(this.dataDir);
	}

	/**
	 * Wipe the entire datastore — peerstore (discovered peers, addresses) and the
	 * identity private key. The network must be stopped. Next start regenerates a
	 * fresh identity and an empty peerstore. Used by the factory reset.
	 */
	async clearDatastore(): Promise<void> {
		if (this.node) throw new CodedError(ErrorCodes.INTERNAL_ERROR, 'Network must be stopped before clearing datastore');
		await clearDatastoreDir(this.dataDir);
	}

	/**
	 * Wipe only the peerstore entries, preserving the identity private key.
	 * The network must be stopped. After restart the node keeps its peer ID
	 * but discovers peers fresh. Used by the factory reset "peers" category.
	 */
	async clearPeerstore(): Promise<void> {
		if (this.node) throw new CodedError(ErrorCodes.INTERNAL_ERROR, 'Network must be stopped before clearing peerstore');
		await clearPeerstoreOnly(this.dataDir);
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
	getTopicPeersInfo(networkID: string): PeerConnectionInfo[] {
		if (!this.pubsub || !this.node) return [];
		const topic = lishTopic(networkID);
		try {
			const subscribers = this.pubsub.getSubscribers(topic);
			return subscribers.map((p: any) => {
				const connections = this.node!.getConnections(p);
				let direct = 0;
				let relay = 0;
				for (const conn of connections) {
					if (Circuit.matches(conn.remoteAddr)) relay++;
					else direct++;
				}
				return { peerID: p.toString(), direct, relay };
			});
		} catch {
			return [];
		}
	}

	async stop(): Promise<void> {
		if (this.statusInterval) {
			clearInterval(this.statusInterval);
			this.statusInterval = null;
		}
		this.peerAnnounce.stop();
		if (this.wantResponseCleanupInterval) {
			clearInterval(this.wantResponseCleanupInterval);
			this.wantResponseCleanupInterval = null;
		}
		this.lastWantResponseTime.clear();
		this.seenSearchIDs.clear();
		if (this._peerCountDebounceTimer) {
			clearTimeout(this._peerCountDebounceTimer);
			this._peerCountDebounceTimer = null;
		}
		// Detach all tracked libp2p/pubsub event listeners before stopping the node,
		// so late-firing events (e.g. peer:disconnect during shutdown) don't hit a half-dead instance
		// and the handlers don't keep closures on `this` alive after stop().
		for (const { target, event, handler } of this.listeners) {
			try {
				target.removeEventListener(event, handler as any);
			} catch (err: any) {
				trace(`[NET] removeEventListener(${event}) failed: ${err?.message ?? err}`);
			}
		}
		this.listeners.length = 0;
		this.topicHandlers.clear();
		// Fix C: clear accumulated per-peer/bootstrap state on stop
		this.dcutrPeers.clear();
		this.bootstrapPeerIDs.clear();
		this.bootstrapTracker.clear();
		this.bootstrapMultiaddrs = [];
		this._lastPeerCounts.clear();
		this._lastScores.clear();
		this.redialBackoff.clear();
		this.pxIngressLogKeys.clear();
		if (this.node) {
			// Drain active connections before stopping. A remote peer that keeps
			// re-dialing during shutdown (keep-alive-fleet ReconnectQueue) can
			// otherwise hold the transport open and node.stop() never resolves —
			// observed between two in-process nodes in integration tests.
			try {
				await Promise.allSettled(this.node.getConnections().map((conn: any) => conn.close().catch(() => {})));
			} catch {
				/* best effort */
			}
			let stopTimer: ReturnType<typeof setTimeout> | undefined;
			const stopped = await Promise.race([Promise.resolve(this.node.stop()).then(() => true), new Promise<boolean>(resolve => (stopTimer = setTimeout(() => resolve(false), 15_000)))]);
			if (stopTimer) clearTimeout(stopTimer);
			if (stopped) console.log('Network stopped');
			else console.warn('[NET] node.stop() timed out after 15s — proceeding with shutdown');
		}
		if (this.datastore) {
			await this.datastore.close();
			console.log('Datastore closed');
		}
		this.node = null;
		this.pubsub = null;
		this.datastore = null;
		this.currentPrivateKey = null;
	}

	async cliFindPeer(peerID: string): Promise<void> {
		const id = peerIDFromString(peerID);
		await this.findPeer(id);
	}

	async findPeer(peerID: PeerID): Promise<void> {
		// DHT removed; debug API now stubbed. Use gossipsub topic subscribers
		// + bootstrap peer list for peer discovery instead.
		console.log('findPeer: DHT removed, only bootstrap + gossipsub peers visible');
		const peers = await this.node!.peerStore.all();
		const match = peers.find(p => p.id.toString() === peerID.toString());
		if (match) {
			console.log('Known multiaddrs:');
			match.addresses.forEach(a => console.log(a.multiaddr.toString()));
		} else {
			console.log('Peer not in peerStore');
		}
	}

	// --- Catalog extensions ---

	getPrivateKey(): PrivateKey {
		if (!this.currentPrivateKey) throw new CodedError(ErrorCodes.NETWORK_NOT_STARTED);
		return this.currentPrivateKey;
	}

	async registerStreamHandler(protocol: string, handler: (stream: Stream) => Promise<void>): Promise<void> {
		if (!this.node) throw new CodedError(ErrorCodes.NETWORK_NOT_STARTED);
		await this.node.handle(protocol, async stream => handler(stream), { runOnLimitedConnection: true });
	}

	registerTopicValidator(topic: string, validator: (peerID: any, msg: any) => Promise<'accept' | 'reject' | 'ignore'>): void {
		if (!this.pubsub) throw new CodedError(ErrorCodes.NETWORK_NOT_STARTED);
		const pubsub = this.pubsub as any;
		if (typeof pubsub.topicValidators?.set === 'function') {
			pubsub.topicValidators.set(topic, async (peerID: any, msg: any) => {
				const result = await validator(peerID, msg);
				// Map string results to gossipsub TopicValidatorResult enum values
				if (result === 'reject') return 'reject';
				if (result === 'ignore') return 'ignore';
				return 'accept';
			});
		}
	}
}

/**
 * Classify a libp2p dial error into a coarse status the UI can render distinctly.
 *
 * - `identity-mismatch`: the remote completed Noise handshake but reported a
 *   different peer ID than the multiaddr's `/p2p/<id>` claimed. Always means
 *   the configured peerID is stale (or the address routes to a wrong node).
 * - `timeout`: the dial never completed — peer offline, behind NAT without relay,
 *   firewall, or unreachable network path.
 * - `error`: every other reason (invalid multiaddr, connection refused, protocol
 *   negotiation failure, etc).
 */
export function classifyBootstrapError(message: string): BootstrapPeerDialStatus {
	if (!message) return 'error';
	if (message.includes('does not match expected remote identity key')) return 'identity-mismatch';
	if (message.includes('timed out') || message.includes('operation was aborted') || message.includes('TimeoutError')) return 'timeout';
	return 'error';
}

/**
 * Parse the actual peerID reported by the remote out of libp2p's identity-mismatch
 * error message. Returns null on shape mismatch (so the UI can fall back to a
 * generic "stale config" message instead of a confident replacement suggestion).
 *
 * Expected message format (libp2p Noise plaintext):
 *   "Payload identity key <ACTUAL_ID> does not match expected remote identity key <EXPECTED_ID>"
 */
export function extractActualPeerID(message: string): string | null {
	const m = message.match(/Payload identity key (\S+) does not match expected remote identity key /);
	return m ? m[1]! : null;
}
