import { createLibp2p } from 'libp2p';
import { Mutex } from 'async-mutex';
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
import { canonicalMultiaddr, extractDestinationPeerID } from './multiaddr-utils.ts';
import { CodedError, ErrorCodes, type NetworkNodeInfo, type PeerConnectionInfo, type IMeshHealth, type BootstrapStatus, type BootstrapPeerDialStatus, type BootstrapPeerOrigin } from '@shared';
import { Circuit } from '@multiformats/multiaddr-matcher';
import { createTopicScoreParams } from '@chainsafe/libp2p-gossipsub/score';
import { type MeshPeer } from '@chainsafe/libp2p-gossipsub';
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

/**
 * How long after a connection opens a peer may still read our shared-LISH listing
 * without appearing as a subscriber of a joined topic. Covers gossipsub SUBSCRIBE
 * propagation for a freshly-dialed peer (the unicast search fallback's window);
 * past it, absence from every joined topic is treated as "not ours to serve".
 * See {@link Network.canListSharesTo}.
 */
const SUBSCRIBE_PROPAGATION_GRACE_MS = 30_000;

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
 */
type TopicHandler = (data: Record<string, any>, from?: string) => void;
const AUTODIAL_WORKAROUND = true;
/** Minimum interval between two `have` responses sent to the same peer for the same LISH. */
const WANT_RESPONSE_COOLDOWN_MS = 60_000;
/** Periodic cleanup of stale entries in lastWantResponseTime (entries older than the cooldown are useless). */
const WANT_RESPONSE_CLEANUP_INTERVAL_MS = 5 * 60_000;
/** Search query dedup window — same `searchID` arriving via mesh within this period is ignored. */
const SEARCH_DEDUP_TTL_MS = 5 * 60_000;
/**
 * Consecutive re-dial failures after which a peer is treated as gone and evicted
 * (peerStore + bootstrap sets + its discovered status rows). Combined with
 * REDIAL_EVICT_MIN_MS so a burst of quick failures right after our own restart
 * or a network partition cannot mass-purge peers that are merely slow to return.
 */
const REDIAL_EVICT_FAILS = 6;
/** Minimum continuous unreachability (since the first recorded failure) before eviction. */
const REDIAL_EVICT_MIN_MS = 30 * 60_000;
/**
 * Discovered bootstrap-status rows older than this (and without a live connection)
 * are dropped from the UI. Live peers keep refreshing their rows via gossip intake;
 * dead ones stop being mentioned, freeze, and expire here.
 */
const BOOTSTRAP_STATUS_STALE_MS = 30 * 60_000;
/**
 * How long an evicted-as-unreachable peer stays quarantined in addBootstrapPeers.
 * Gossip from nodes that still remember the dead peer keeps mentioning it; without
 * this window every mention would re-create its status row and burn a dial. Once
 * the window lapses a single probe is allowed again (self-heals on peer return).
 *
 * Kept equal to BOOTSTRAP_STATUS_STALE_MS deliberately: shorter would let stale
 * gossip refresh rows faster than the sweep can expire them; longer would only
 * delay re-discovery of a peer that genuinely came back (a returned peer that
 * dials US escapes immediately via the peer:connect reset — this window matters
 * only for peers that cannot initiate inbound connections).
 */
const UNREACHABLE_QUARANTINE_MS = 30 * 60_000;

/**
 * Backoff ceiling for the loops that probe ONE CONFIGURED ADDRESS.
 *
 * A configured entry is exempt from eviction and from quarantine — it is user data and
 * the way back into the network — but "never given up on" is not "dialed without limit".
 * Each attempt spends a 10 s dial timeout, so a handful of dead configured addresses
 * could occupy a status tick end to end, every tick, forever.
 *
 * Half the general re-dial ceiling (10 min) deliberately: a configured address deserves
 * to be retried more often than a gossip-learned one, so a bootstrap that comes back is
 * picked up within five minutes without the operator touching anything, while a
 * permanently dead one costs one dial per five minutes instead of one per 30 s tick.
 */
const CONFIGURED_PROBE_BACKOFF_MAX_MS = 5 * 60_000;

/**
 * Ceiling on the autodial list zero-connection recovery walks.
 *
 * A discovered address earns its place by answering a dial, so the list grows with the
 * number of distinct endpoints that have ever worked — unbounded on a fleet with churn,
 * and the array is otherwise only ever shortened by an identity purge. Over the ceiling
 * the OLDEST DISCOVERED entry goes: configured entries are finite user data and the way
 * back into a network, so they are never the ones dropped. 512 is far above any real
 * node's working set while keeping the list, and the walk over it, bounded.
 */
const MAX_BOOTSTRAP_ADDRESSES = 512;

/**
 * Where the eviction window should run from after a re-dial failure.
 *
 * A failure only says something about the PEER when this node can reach anyone
 * at all. While we are the disconnected one — laptop asleep, Wi-Fi off, VPN
 * dropped — every dial fails, so the window is slid forward instead of
 * accumulating. Without this, a local outage longer than REDIAL_EVICT_MIN_MS
 * would evict the whole non-configured peerStore on the first dial after the
 * connection came back.
 */
/**
 * Whether zero-connection recovery may dial a DISCOVERED address this tick.
 *
 * It answers with the two records re-dial maintenance already keeps: a peer inside its
 * backoff window waits for it to expire, and one still inside its unreachable
 * quarantine stays down. Both are delays, never permanent bans — the point is only
 * that the recovery loop must not undo the pacing the other loop just applied.
 */
export function isRecoveryDialDue(peerID: string, now: number, redialBackoff: ReadonlyMap<string, { nextAttempt: number }>, quarantine: ReadonlyMap<string, number>): boolean {
	const quarantinedAt = quarantine.get(peerID);
	if (quarantinedAt !== undefined && now - quarantinedAt < UNREACHABLE_QUARANTINE_MS) return false;
	const backoff = redialBackoff.get(peerID);
	return backoff === undefined || backoff.nextAttempt <= now;
}

export function nextEvictionWindowStart(reachable: boolean, previous: number | undefined, now: number): number {
	return reachable ? (previous ?? now) : now;
}

/**
 * How many failures count TOWARDS EVICTION after another one.
 *
 * Counted separately from the backoff's failCount, which must keep growing through a
 * local outage so we stop hammering the dialer. Eviction asks a different question —
 * "has the PEER failed us N times?" — and a dial attempted while we had no connectivity
 * answers nothing, so the run resets. Without this, two hours offline bank enough
 * failures that the peer is evicted after the window even though only a couple of
 * genuine failures happened once we were back: the backoff caps at 10 minutes, so a
 * 30-minute window holds barely three attempts.
 */
export function nextEvictionFailCount(reachable: boolean, previous: number | undefined): number {
	return reachable ? (previous ?? 0) + 1 : 0;
}

/**
 * Whether a run of re-dial failures has earned an eviction.
 *
 * Eviction is destructive — it purges the peerStore entry, drops the status row
 * and quarantines the ID — so it needs all four conditions at once: we are
 * demonstrably online, the peer has failed enough times, it has been failing for
 * long enough, and it is not one the operator configured by hand.
 */
export function shouldEvictUnreachablePeer(input: { reachable: boolean; failCount: number; unreachableForMs: number; configured: boolean }): boolean {
	if (!input.reachable || input.configured) return false;
	return input.failCount >= REDIAL_EVICT_FAILS && input.unreachableForMs >= REDIAL_EVICT_MIN_MS;
}
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
 * Where the node is in its start/stop cycle.
 *
 * `this.node` alone cannot express this: it is set half-way through {@link Network.start}
 * and stays set for the whole of {@link Network.stop}, so a failed start left a node
 * object that never started looking exactly like a running one, and a caller starting
 * during a stop was told "already running" and then had its node torn down under it.
 * Only a fully successful start reaches `running`.
 *
 * `failed` is the state of a stop that could not prove the node down. The run is neither
 * running nor over: the node may still hold its listener, its connections and its port,
 * and nothing has proved otherwise. Reporting `stopped` there is what allowed a second
 * node over the same identity, port and datastore, and a datastore wipe underneath a live
 * one. A `failed` whose libp2p stop was interrupted is permanent — libp2p cannot resume
 * one, see {@link Network.teardown} — and only a process restart clears it. A `failed`
 * whose libp2p stop succeeded and whose cleanup then failed can be left by a stop that
 * completes the remaining cleanup.
 */
export type NetworkLifecycle = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

/**
 * Whether a bootstrap dial run walked its WHOLE list.
 *
 * `'completed'` says every address was processed by the run that started it — reached,
 * skipped as non-routable, backed off, or dialed and failed. An ordinary unreachable
 * address is processed; nothing more will be attempted for it until the list changes.
 *
 * `'incomplete'` says the run ended early: the node was replaced, the shutdown cancelled
 * this run's dials, or the network's configured list was superseded. Addresses past that
 * point were never touched, and no comparison of "what we asked for" against "what we
 * asked for" can discover it — see {@link Networks.appliedBootstrap}.
 */
export type BootstrapDialResult = 'completed' | 'incomplete';

/**
 * Single shared libp2p node.
 * LISH networks are logical groups represented as pubsub topics on this one node.
 */
export class Network {
	private lifecycle: NetworkLifecycle = 'stopped';
	/**
	 * Serialises start() against stop(). Both mutate the same fields across several
	 * awaits, and without this two concurrent start() calls could both pass the
	 * "already running" check before either created a node — two libp2p instances over
	 * one identity and one SQLite datastore.
	 */
	private readonly lifecycleMutex = new Mutex();
	/**
	 * Set once a `node.stop()` has failed to leave libp2p in `stopped`. Permanent: libp2p
	 * has no way to resume an interrupted stop, so every later attempt would be a no-op
	 * dressed up as success. See {@link teardown}.
	 */
	private nodeStopUnrecoverable = false;
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
	 * Delayed peer-count probes armed by subscribeTopic. Tracked so stop() can cancel
	 * them: without that they keep a closure on this instance alive and can fire against
	 * a node the run no longer owns, which is exactly the ownership the epoch guards
	 * elsewhere are there to enforce.
	 */
	private readonly delayedPeerCountTimers: Set<ReturnType<typeof setTimeout>> = new Set();
	/** Guards against overlapping status ticks — see setupStatusInterval. */
	private statusTickInFlight = false;
	/**
	 * Lifecycle epoch, bumped by stop(). A status tick captures the epoch at
	 * entry and refuses to write per-peer state once it differs — an in-flight
	 * tick otherwise survives stop() and would repopulate freshly-cleared maps
	 * or purge peers of the NEXT node instance (whose configured peers are not
	 * loaded yet) after a quick stop/start such as a factory reset.
	 */
	private runEpoch = 0;
	/**
	 * Aborts the bootstrap dial loop, for a shutdown that has to wait for it.
	 *
	 * The loop dials sequentially and one unreachable address costs a full connection
	 * timeout, so a caller that waits for a join to finish before stopping the node would
	 * otherwise wait out the whole list. Replaced on every {@link start}: an abort belongs to
	 * the run it was raised for and must not refuse the next run's first dial.
	 */
	private dialAbort = new AbortController();
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
	/**
	 * Peer IDs whose bootstrap entries came from explicit network config
	 * ('configured' origin — startup config or a manual bootstrap edit). Kept
	 * separate from bootstrapPeerIDs, which also collects peer-announce
	 * discoveries: those are plain content peers and must remain
	 * disconnectable by lishnet leave (isBootstrapOrRelayPeer).
	 *
	 * This is also what exempts a peer from unreachable-eviction: configured
	 * entries are user data, so a bootstrap hub that is down for half an hour must
	 * keep its peerStore entry and its addrs instead of being purged. Both
	 * questions — "is this infrastructure?" and "may we evict it?" — are the same
	 * question about the same fact, so they read the same set. Keeping two sets for
	 * it meant they could disagree, and they did: only one of them was ever pruned,
	 * so a peer the user had already removed from the config stayed eviction-exempt
	 * until restart.
	 */
	private configuredBootstrapPeerIDs: Set<string> = new Set();
	/**
	 * Canonical bootstrap ADDRESSES that came from saved config, as opposed to gossip.
	 *
	 * Kept alongside the peer-ID set because the two answer different questions. Whether
	 * a PEER may be auto-evicted is about identity — configured anywhere means exempt.
	 * Whether an ADDRESS gets the configured treatment in recovery is about that address:
	 * one peer can have a configured address and a gossip-learned one at the same time,
	 * and the gossip-learned one must not inherit the exemption from its sibling.
	 */
	private readonly configuredBootstrapAddresses: Set<string> = new Set();
	private dcutrPeers: Set<string> = new Set();
	private bootstrapMultiaddrs: any[] = [];
	/**
	 * Per-network bootstrap-config version, bumped on every replace / reset / leave.
	 * Read by {@link addBootstrapPeers} so a job started for a superseded list stops
	 * instead of re-adding entries that are no longer configured.
	 */
	private readonly bootstrapGeneration: Map<string, number> = new Map();

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
	 * context. Lets the UI surface which SPECIFIC bootstrap entry is stale
	 * (identity-mismatch) or unreachable (timeout), rather than flagging the
	 * whole network.
	 *
	 * Populated both for configured bootstrap entries (initial join + manual
	 * updates) and for peer-announce gossip: the inbound handler passes the
	 * networkID of the topic the announce arrived on, so discovered peers are
	 * tracked under the network through which they were learned.
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

	/**
	 * Handlers subscribed via {@link onPeerDisconnect}. Held at Network level
	 * (not bound to a node instance) so subscriptions survive node restarts.
	 */
	private readonly peerDisconnectHandlers = new Set<(peerID: string) => void>();

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
	private readonly redialBackoff = new Map<string, { nextAttempt: number; failCount: number; firstFailure: number; evictionFails: number }>();
	/** peerID → eviction time. Blocks re-adding a just-evicted unreachable peer from gossip for UNREACHABLE_QUARANTINE_MS. */
	private readonly unreachableQuarantine = new Map<string, number>();
	/**
	 * Canonical multiaddr → pacing record for the loops that probe ONE CONFIGURED ADDRESS
	 * (zero-connection recovery and the parked-bootstrap probe).
	 *
	 * Keyed by ADDRESS, not by peer, because those loops ask an address-level question.
	 * One peer can hold a dead configured address and a working one at the same time;
	 * with a peer-keyed record the dead address's failure puts the whole peer into
	 * backoff, the working address is skipped for the rest of the pass, and the next pass
	 * starts at the dead one again — so the working address could go untried indefinitely.
	 */
	private readonly addressProbeBackoff = new Map<string, { nextAttempt: number; failCount: number }>();
	/**
	 * Canonical multiaddrs with an {@link addBootstrapPeers} dial currently outstanding.
	 *
	 * The pubsub dispatcher does not await the announce handler, so several announces
	 * naming the same address start several intake runs that overlap. Each spends its own
	 * 10 s dial timeout on the same endpoint and records its own outcome over the other's,
	 * and the peer-level backoff cannot help — it is only written once a dial has already
	 * failed. Claiming the address for the duration of the dial makes the second run a
	 * no-op instead: the first one is about to record the outcome both were after.
	 *
	 * Replaced with a FRESH Set on teardown rather than cleared, and captured by reference
	 * for the length of a dial. Clearing a shared Set let a dial still settling on the old
	 * node release a claim the new node's dial of the same address had just taken — after
	 * which a third request saw the address free and duplicated the live dial.
	 */
	private inFlightBootstrapDials = new Set<string>();
	/**
	 * Peer IDs with a `peer:discovery` dial currently outstanding.
	 *
	 * Keyed by PEER, not by address, because that is the question discovery asks: mDNS,
	 * identify and PX all raise an event for the same arrival, each carrying its own
	 * address list, and the per-peer backoff cannot separate them — it is written only
	 * after a dial has already failed. Replaced on teardown for the same reason as
	 * {@link inFlightBootstrapDials}.
	 */
	private inFlightDiscoveryDials = new Set<string>();
	/**
	 * Peers deliberately hung up by {@link disconnectPeer} (leave-network), keyed by
	 * the lishnet they were left with. Redial maintenance / discovery must NOT
	 * proactively re-dial them — otherwise a peer we just left is re-connected within
	 * one status tick (~30s), defeating the leave. Per-network so rejoining lishnet A
	 * lifts only A's peers (not still-left B's — {@link clearRedialSuppressionForNetwork}).
	 * A peer observed reconnecting by any path is lifted from ALL sets
	 * ({@link clearRedialSuppressionForPeer}). Bounded by peers of currently-left
	 * lishnets; drained on rejoin/reconnect and cleared in stop(). NOT pruned against
	 * the peerStore: leave purges the peer from the store, which would drop the
	 * suppression and let mDNS rediscovery reconnect within a tick.
	 */
	private readonly redialSuppressedByNet = new Map<string, Set<string>>();

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
		// Lets the discovered-row cap keep live participants and drop dead addresses first.
		this.bootstrapTracker.setMembersProvider((networkID): Set<string> => new Set(this.getTopicPeers(networkID)));
		this.peerAnnounce = new PeerAnnounceManager({
			getNode: (): Libp2p | null => this.node,
			getPubsub: (): any => this.pubsub,
			broadcast: (topic, msg, pubsub): Promise<void> => Network.publishOn(pubsub, topic, msg),
			addBootstrapPeers: (multiaddrs, networkID, origin): Promise<BootstrapDialResult> => this.addBootstrapPeers(multiaddrs, networkID, origin),
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
	 * Subscribe to peer disconnects for the duration of the returned disposer.
	 * The handler receives the disconnected peer's ID as a string.
	 *
	 * Handlers live at Network level, NOT on the current libp2p node: the
	 * permanent `peer:disconnect` listener installed by {@link start} fans out
	 * to this set, so subscriptions survive a node restart (identity
	 * import/regenerate) that would otherwise silently drop them together with
	 * the old node's listeners. Used by downloads to drop a vanished peer from
	 * their per-LISH peer manager immediately, instead of waiting for the next
	 * failed dial/probe to notice the dead connection.
	 */
	onPeerDisconnect(handler: (peerID: string) => void): () => void {
		this.peerDisconnectHandlers.add(handler);
		return () => this.peerDisconnectHandlers.delete(handler);
	}

	/**
	 * Schedule a debounced check of peer counts for all subscribed topics.
	 */
	/** Arm a one-shot peer-count probe that stop() can still cancel. */
	private armDelayedPeerCountCheck(delayMs: number): void {
		const epoch = this.runEpoch;
		const timer = setTimeout(() => {
			this.delayedPeerCountTimers.delete(timer);
			if (epoch !== this.runEpoch) return;
			this.schedulePeerCountCheck();
		}, delayMs);
		this.delayedPeerCountTimers.add(timer);
	}

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
		// Serialised against stop() and against another start(): every field below is
		// touched across awaits by both, so overlapping runs would interleave into two
		// nodes over one datastore, or into a start whose node a concurrent stop tears
		// down while its caller is told the start succeeded.
		await this.lifecycleMutex.runExclusive(async () => {
			// A previous run that could not be stopped may still own this identity, this
			// port and this datastore. Starting a second node over it is the one thing
			// that state exists to prevent, and "already running" would be a lie.
			if (this.lifecycle === 'failed') throw new CodedError(ErrorCodes.INTERNAL_ERROR, 'Network is in a failed state: the previous node could not be stopped');
			if (this.lifecycle !== 'stopped') {
				console.log('Network node is already running');
				return;
			}
			this.lifecycle = 'starting';
			// A fresh one per run — an abort raised for the previous shutdown would otherwise
			// refuse this run's dials before it made any. See {@link dialAbort}.
			this.dialAbort = new AbortController();
			try {
				await this.startLocked(bootstrapPeers);
				this.lifecycle = 'running';
			} catch (err) {
				// A half-built start owns a datastore handle and possibly a libp2p node.
				// Leaving either behind is what made a failed start unrecoverable without
				// restarting the process: the SQLite file stayed locked and `this.node`
				// stayed set, so the next start reported "already running" forever.
				try {
					await this.teardown();
				} catch (teardownErr) {
					// The cleanup could not prove the half-built node is down, so the next
					// start must be refused rather than opening a second one over the same
					// identity. Both reasons are kept: the start error explains what went
					// wrong, the teardown error explains why the instance is now unusable.
					this.lifecycle = 'failed';
					throw new AggregateError([err, teardownErr], 'network start failed and its cleanup could not complete');
				}
				this.lifecycle = 'stopped';
				throw err;
			}
		});
	}

	/** The body of {@link start}, run under the lifecycle mutex. */
	private async startLocked(bootstrapPeers: string[]): Promise<void> {
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
		// Config-time bootstrap entries are by definition 'configured'.
		this.configuredBootstrapPeerIDs = new Set(bootstrapPeerIDs);
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
					await handleLISHProtocol(
						stream,
						this.dataServer,
						remotePeerID,
						connType,
						pid => this.sharesJoinedTopicWith(pid),
						pid => this.canListSharesTo(pid)
					);
				} catch (err: any) {
					trace(`[NET] LISH handler error: ${err?.message ?? err}`);
				}
			},
			{ runOnLimitedConnection: true }
		);
		console.log(`✓ Registered ${LISH_PROTOCOL} protocol handler`);

		// DHT removed; only bootstrap + gossipsub for discovery

		this.addListener(this.pubsub, 'gossipsub:graft', (evt: CustomEvent<MeshPeer>) => {
			trace(`[NET] GRAFT: ${evt.detail.peerId} joined ${evt.detail.topic}`);
			this.lastMeshChange.set(evt.detail.topic, Date.now());
			this.noteMeshGraft(evt.detail);
			this.schedulePeerCountCheck();
		});

		this.addListener(this.pubsub, 'gossipsub:prune', (evt: CustomEvent<MeshPeer>) => {
			trace(`[NET] PRUNE: ${evt.detail.peerId} left ${evt.detail.topic}`);
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
			// A peer we deliberately left (leave-network) must not be re-tagged or
			// re-dialed by discovery (mDNS/identify/PX) — that would beat the disconnect.
			// Suppression lifts on a legitimate inbound reconnect or on network rejoin.
			if (this.isRedialSuppressed(peerID)) return;
			// Stamp `keep-alive-fleet` on a peer we are actually CONNECTED to, however it
			// surfaced (mDNS, bootstrap, autonat, identify, peer-announce). libp2p
			// ReconnectQueue only acts on peers with a tag whose key starts with
			// `keep-alive`; without it, fleet peers found via non-announce channels
			// (e.g. identify push from a common neighbour) are not re-dialed when
			// they drop. Value 50 sits between bootstrap (100) and idle (1) — protects
			// from ConnectionPruner without taking precedence over true bootstraps.
			//
			// Never on a mere discovery event, though: the tag is a standing instruction
			// to libp2p to keep re-dialing this identity, and a discovery event is only
			// somebody's claim that the peer exists. Stamping it before any contact let a
			// peer that had just been evicted as unreachable get its re-dial instruction
			// back from a late mDNS or PX event, ReconnectQueue included.
			const tagAsFleetPeer = async (): Promise<void> => {
				try {
					await this.node!.peerStore.merge(evt.detail.id, {
						tags: { 'keep-alive-fleet': { value: 50 } },
					});
				} catch {
					/* ignore */
				}
			};
			const existing = this.node!.getConnections(evt.detail.id);
			if (existing.length > 0) {
				await tagAsFleetPeer();
				return;
			}
			if (!evt.detail.multiaddrs?.length) return;
			// The same pacing every other dial path respects. Discovery is a firehose —
			// mDNS, identify and PX all deliver events for peers we have already written
			// off — and this handler used to answer each one with an immediate dial, which
			// could undo an eviction the moment it happened.
			if (!isRecoveryDialDue(peerID, Date.now(), this.redialBackoff, this.unreachableQuarantine)) {
				trace(`[NET] discovery dial skipped (quarantined or in backoff): ${peerID.slice(0, 16)}`);
				return;
			}
			// Single-flight per peer. The backoff above is only written once a dial has
			// already FAILED, so several discovery events for one peer — mDNS, identify and
			// PX all fire for the same arrival — used to pass it together and start that
			// many concurrent dials of the same identity. Captured by reference for the same
			// reason the bootstrap claims are: a teardown replaces the set, and releasing
			// into the replacement would free the next run's claim.
			const inFlight = this.inFlightDiscoveryDials;
			if (inFlight.has(peerID)) {
				// Only the DIAL is skipped; the addresses are not lost. libp2p's own
				// `#onDiscoveryPeer` merges every discovery service's address list into the
				// peerStore before this public event is dispatched, so a second merge here
				// would be an unguarded write that adds nothing — and one that can land after
				// a leave, an eviction or a stop and reinstate addresses those just removed.
				trace(`[NET] discovery dial skipped (already in flight): ${peerID.slice(0, 16)}`);
				return;
			}
			inFlight.add(peerID);
			const epoch = this.runEpoch;

			try {
				await this.node!.dial(evt.detail.multiaddrs);
				// A dial that settles after stop() belongs to a node this run no longer owns.
				if (epoch !== this.runEpoch) return;
				// The suppression check at entry answered for the moment the event arrived,
				// and a dial takes seconds. leave-network can land inside that window: its
				// hangUp finds no connection yet, finishes, and this dial then completes into
				// a connection nothing else will close. Whoever notices last closes it.
				if (this.isRedialSuppressed(peerID) && !this.isPeerNeededByJoinedNetwork(peerID)) {
					trace(`[NET] discovery dial landed after leave, hanging up: ${peerID.slice(0, 16)}`);
					try {
						await this.node!.hangUp(evt.detail.id);
					} catch (err: any) {
						trace(`[NET] hangUp of late discovery dial failed: ${err?.message ?? err}`);
					}
					return;
				}
				await tagAsFleetPeer();
				trace(`[NET] Dialed discovered peer ${peerID.slice(0, 16)}`);
			} catch (err: any) {
				if (epoch !== this.runEpoch) return;
				// Pay the failure into the shared backoff the gate above reads, so a peer
				// discovery keeps naming is paced like everything else.
				this.noteRecoveryDialFailure(peerID);
				trace(`[NET] Failed to dial discovered peer ${peerID.slice(0, 16)}: ${err?.message ?? err}`);
			} finally {
				inFlight.delete(peerID);
			}
		});

		// Async listener — any rejection must be caught or it becomes unhandledRejection
		this.addListener(this.node!, 'peer:connect', async (evt: any) => {
			try {
				const peerID = evt.detail.toString();
				this.unreachableQuarantine.delete(peerID);
				// Any verified connection resets the failure history — without this, a
				// flappy NAT/relay peer that connects and drops BETWEEN status ticks
				// keeps accumulating failCount across its live episodes and eventually
				// gets evicted as "unreachable for 30 minutes" despite never being
				// gone that long.
				this.redialBackoff.delete(peerID);
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
				// A mere reconnect does NOT lift leave-network suppression: a peer we left can
				// dial us back (its own keep-alive/mDNS) without rejoining a shared topic, and
				// clearing here would remove the only marker canListSharesTo uses to refuse it.
				// Suppression lifts only on an explicit rejoin (clearRedialSuppressionForNetwork)
				// or once the peer is verifiably back on a joined topic (genuine mesh reconnect).
				if (this.sharesJoinedTopicWith(peerID)) this.clearRedialSuppressionForPeer(peerID);
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
			// Fan out to Network-level subscribers (see onPeerDisconnect).
			for (const h of this.peerDisconnectHandlers) {
				try {
					h(peerID);
				} catch (err: any) {
					trace(`[NET] peer-disconnect subscriber error: ${err?.message ?? err}`);
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
			// Serialize ticks: with many unreachable peers the re-dial phase (5 s
			// timeout × candidates ÷ concurrency) can exceed the 30 s cadence. Two
			// interleaved ticks would race on redialBackoff — one tick could evict
			// (and close connections of) a peer another tick just reconnected.
			if (this.statusTickInFlight) return;
			this.statusTickInFlight = true;
			const epoch = this.runEpoch;
			try {
				const connectedPeers = this.node!.getPeers();
				const allPeers = await this.node!.peerStore.all();
				logStatusDebug({ node: this.node, pubsub: this.pubsub, settings: this.settings, lastScores: this._lastScores }, connectedPeers, allPeers);
				dumpGossipsubScores({ node: this.node, pubsub: this.pubsub, settings: this.settings, lastScores: this._lastScores }, connectedPeers);
				// Periodic peer count refresh — catches cases where GRAFT/PRUNE events were missed
				this.checkPeerCounts();
				await this.runRedialMaintenance(connectedPeers, allPeers, epoch);
				if (epoch !== this.runEpoch) return;
				await this.runZeroConnectionRecovery(epoch);
				if (epoch !== this.runEpoch) return;
				await this.maybePromotePeers(epoch);
				if (epoch !== this.runEpoch) return;
				this.sweepStaleBootstrapRows();
			} catch (err: any) {
				trace(`[NET] statusInterval error: ${err?.message ?? err}`);
			} finally {
				// Only release the guard for the run we belong to — after a stop()/start()
				// the flag belongs to the new run, whose own tick may already hold it.
				if (epoch === this.runEpoch) this.statusTickInFlight = false;
			}
		}, 30000);
		// Status interval 30 s. promoteKnownPeersToBootstrap + gossipsub.direct
		// mutations run on the 5th tick (~150 s) — fast enough to absorb peer
		// churn at N≈100 without flooding logs or burning CPU on per-second probes.
	}

	/**
	 * Expire discovered status rows whose peer has stopped answering — the participant
	 * list forgetting a peer that went away.
	 *
	 * Swept by per-network membership (topic subscribers), not global connectivity: a peer
	 * that left this network but stays connected via another must still have its stale row
	 * here expire. The per-topic snapshot is taken lazily and freshly — the tick-start
	 * state is stale by the time the re-dial phase is done, and a peer that (re)subscribed
	 * during it must not be swept. `now` is injectable, like the sweep's own, so a test can
	 * age rows without waiting out the window.
	 */
	private sweepStaleBootstrapRows(now: number = Date.now()): void {
		const topicMembers = new Map<string, Set<string>>();
		const isMember = (networkID: string, pid: string): boolean => {
			let set = topicMembers.get(networkID);
			if (!set) {
				set = new Set(this.getTopicPeers(networkID));
				topicMembers.set(networkID, set);
			}
			return set.has(pid);
		};
		this.bootstrapTracker.sweepStale(BOOTSTRAP_STATUS_STALE_MS, isMember, now);
	}

	/**
	 * Flat view over the per-network sets: whether a peer was deliberately hung up by
	 * leave-network (via disconnectPeer) for ANY left lishnet, so no maintenance path
	 * (redial loop, zero-connection recovery, promote, discovery) re-dials it.
	 */
	private isRedialSuppressed(peerID: string): boolean {
		for (const set of this.redialSuppressedByNet.values()) if (set.has(peerID)) return true;
		return false;
	}

	/** Record a peer as left with a specific lishnet so maintenance won't re-dial it. */
	private addRedialSuppression(networkID: string, peerID: string): void {
		let set = this.redialSuppressedByNet.get(networkID);
		if (!set) {
			set = new Set();
			this.redialSuppressedByNet.set(networkID, set);
		}
		set.add(peerID);
	}

	/**
	 * Lift suppression for one lishnet's peers — called on (re)join of that lishnet.
	 * Scoped: rejoining A does not unblock still-left B's peers (nor lift the
	 * canListSharesTo browse-privacy protecting B).
	 */
	clearRedialSuppressionForNetwork(networkID: string): void {
		this.redialSuppressedByNet.delete(networkID);
	}

	/** Lift suppression for one peer across ALL left lishnets — a legitimate reconnect. */
	private clearRedialSuppressionForPeer(peerID: string): void {
		for (const set of this.redialSuppressedByNet.values()) set.delete(peerID);
	}

	private async runRedialMaintenance(connectedPeers: any[], allPeers: any[], epoch: number = this.runEpoch): Promise<void> {
		// Dial known peers not currently connected (maintains relay connections to NATed peers)
		const connectedSet = new Set(connectedPeers.map(p => p.toString()));
		const now = Date.now();
		// Build candidate list: all known peers that are (a) not connected, and
		// (b) past their backoff window. Bootstrap peers are included so a bootstrap
		// that drops comes back quickly without needing connectedPeers.length===0.
		const candidates: Array<{ peer: any; pid: string; addrSummary: string; failCount: number }> = [];
		let skippedBackoff = 0;
		let skippedNoReachable = 0;
		let skippedSuppressed = 0;
		let skippedQuarantined = 0;
		const localCidrs = getLocalCidrs(now);
		for (const peer of allPeers) {
			if (epoch !== this.runEpoch) return; // stop() hit — this run's state is gone
			const pid = peer.id.toString();
			if (connectedSet.has(pid)) {
				this.redialBackoff.delete(pid); // clear on observed connection
				this.unreachableQuarantine.delete(pid);
				if (this.sharesJoinedTopicWith(pid)) this.clearRedialSuppressionForPeer(pid); // back on a shared topic → resume
				continue;
			}
			// Skip peers we deliberately left (leave-network) so maintenance does not
			// silently re-dial them; cleared above once they reconnect on their own.
			if (this.isRedialSuppressed(pid)) {
				skippedSuppressed++;
				continue;
			}
			// A peer evicted as unreachable is normally gone from the peerStore and so
			// cannot be a candidate at all — but that delete is best-effort, and mDNS,
			// identify and peer-announce can all put the entry back. Honour the quarantine
			// here too, or the very next tick dials the peer we just wrote off. Configured
			// peers are never quarantined; the check is stated anyway so no future writer
			// can hold user data back by adding one.
			const quarantinedAt = this.unreachableQuarantine.get(pid);
			if (quarantinedAt !== undefined && now - quarantinedAt < UNREACHABLE_QUARANTINE_MS && !this.configuredBootstrapPeerIDs.has(pid)) {
				skippedQuarantined++;
				continue;
			}
			const bo = this.redialBackoff.get(pid);
			// Pre-filter peerStore multiaddrs through the dial gater. If every
			// known address is unreachable from this node (e.g. only LAN addrs
			// of a foreign subnet), skip the dial entirely — otherwise libp2p
			// returns "no valid addresses" after still spending a slot on us.
			//
			// Deliberately ahead of the backoff gate below: a peer waiting out a
			// backoff is precisely the one the reset has to reach, since it carries
			// the accumulated window that would evict it on the first failure after
			// the route returns. The cost is one gater pass per parked peer per tick
			// — address parsing and integer compares against a cached CIDR list,
			// nothing next to the 5 s dial it guards.
			const entries = peer.addresses ?? [];
			const reachable: string[] = [];
			for (const a of entries) {
				const ma = a?.multiaddr;
				if (!ma) continue;
				if (!shouldDenyDial(ma, localCidrs)) reachable.push(ma.toString());
			}
			if (reachable.length === 0) {
				skippedNoReachable++;
				// Skipped, never evicted. "Unreachable" here means the dial gater rejects
				// every stored address FROM WHERE WE STAND, which says nothing about the
				// peer: one reachable only over a LAN or VPN subnet looks exactly like this
				// the moment that interface drops. No dial happens on this path, so there is
				// no failure evidence to weigh either — and "we hold some other connection"
				// does not supply any, since the Ethernet link stays up while the VPN dies.
				// The peer is therefore parked, not purged: it stops being dialled, its
				// discovered rows expire on their own staleness clock, and libp2p's own
				// maxPeerAge retires the peerStore entry. Eviction stays with the dial-failure
				// path below, which at least tried addresses this host could route to.
				//
				// The stretch also invalidates the evidence collected BEFORE it. That window
				// means CONTINUOUS unreachability of the peer, and nothing observed while we
				// had no route to it can be attributed to the peer — so the run of failures
				// ends here and a fresh window starts once a route returns. Re-stamped on
				// every tick that finds no route — backoff or not, see the ordering note
				// above — which costs one map write and keeps the restart point at the end
				// of the outage rather than its beginning. Pacing (nextAttempt, failCount)
				// is deliberately kept: the peer still is not answering, and dropping it
				// would dial every parked peer at once the moment a route appears.
				if (bo) this.redialBackoff.set(pid, { ...bo, firstFailure: now, evictionFails: 0 });
				continue;
			}
			if (bo && bo.nextAttempt > now) {
				skippedBackoff++;
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
				if (epoch !== this.runEpoch) return; // stop() hit — abandon remaining dials
				const c = candidates[idx++]!;
				console.debug(`   ↻ Re-dial attempt peer=${c.pid} addrs=${c.addrSummary} fails=${c.failCount}`);
				try {
					await this.node!.dial(c.peer.id, { signal: AbortSignal.timeout(5000) });
					// Same guard as the failure path: a dial resolving after stop() must
					// not write into the next run's state or the next node's peerStore.
					if (epoch !== this.runEpoch) return;
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
					// A dial aborted by stop() looks like any other failure — do not let
					// it repopulate maps that stop() just cleared, or evict against the
					// NEXT node instance.
					if (epoch !== this.runEpoch) return;
					// Exponential backoff: 30s × 2^failCount, capped at 10 min.
					const nextFailCount = c.failCount + 1;
					const delayMs = Math.min(30_000 * 2 ** c.failCount, 600_000);
					const reachable = this.hasConnectionOtherThan(c.peer.id);
					const previous = this.redialBackoff.get(c.pid);
					const firstFailure = nextEvictionWindowStart(reachable, previous?.firstFailure, Date.now());
					const evictionFails = nextEvictionFailCount(reachable, previous?.evictionFails);
					this.redialBackoff.set(c.pid, { nextAttempt: Date.now() + delayMs, failCount: nextFailCount, firstFailure, evictionFails });
					console.debug(`   ✗ Re-dial peer=${c.pid} failed: ${err.message ?? err} (tried: ${c.addrSummary}, next in ${Math.round(delayMs / 1000)}s)`);
					// Enough consecutive failures over enough time ⇒ the peer is gone, not
					// flaky. The dial above went by peer ID, so libp2p tried EVERY known
					// address — one broken addr among working ones cannot trip this. Evict
					// everywhere (peerStore, bootstrap sets, discovered status rows) and
					// quarantine the ID so gossip mentions don't immediately re-add it.
					// Configured bootstrap peers are exempt — user data, they must survive
					// any outage and keep their red status row instead.
					if (shouldEvictUnreachablePeer({ reachable, failCount: evictionFails, unreachableForMs: Date.now() - firstFailure, configured: this.configuredBootstrapPeerIDs.has(c.pid) })) {
						// Last-moment liveness check: the peer may have connected (inbound
						// dial, another async path) while this worker was failing on stale
						// state. purgeStalePeer closes connections, so evicting here would
						// cut a LIVE peer — verify emptiness right before acting.
						if (this.node && this.node.getConnections(c.peer.id).length > 0) {
							this.redialBackoff.delete(c.pid);
							continue;
						}
						this.unreachableQuarantine.set(c.pid, Date.now());
						this.redialBackoff.delete(c.pid);
						this.bootstrapTracker.deleteDiscoveredByPeerID(c.pid);
						await this.purgeStalePeer(c.pid, `unreachable after ${evictionFails} re-dial failures over ${Math.round((Date.now() - firstFailure) / 60_000)} min`, epoch);
					}
				}
			}
		};
		const workers = Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker());
		await Promise.all(workers);
		if (candidates.length > 0 || skippedBackoff > 0 || skippedNoReachable > 0 || skippedSuppressed > 0 || skippedQuarantined > 0) {
			console.debug(`   Re-dial: ${redialSuccess}/${candidates.length} succeeded (${skippedBackoff} skipped by backoff, ${skippedNoReachable} skipped no-reachable-addrs, ${skippedSuppressed} skipped left-peer, ${skippedQuarantined} skipped quarantined)`);
		}
		// Prune backoff entries for peers no longer in peerStore to prevent unbounded growth.
		// Suppression is NOT pruned this way: leave-network purges the peer from the
		// peerStore, so pruning against it would drop the suppression and let mDNS
		// rediscovery reconnect the left peer within a tick. Suppression is instead
		// bounded by clear-on-rejoin / clear-on-reconnect / stop().
		const storeSet = new Set(allPeers.map(p => p.id.toString()));
		for (const pid of this.redialBackoff.keys()) if (!storeSet.has(pid)) this.redialBackoff.delete(pid);
		// Quarantine entries for peers gossip never mentions again would leak — drop
		// them once they are far past the window (re-entry from gossip self-cleans).
		const quarantineCutoff = now - 2 * UNREACHABLE_QUARANTINE_MS;
		for (const [pid, ts] of this.unreachableQuarantine) if (ts < quarantineCutoff) this.unreachableQuarantine.delete(pid);
	}

	/**
	 * Whether a per-ADDRESS probe of a configured entry is due.
	 *
	 * An address nothing has failed on yet is always due; one that failed waits out the
	 * window {@link noteAddressProbeFailure} set for it.
	 */
	private isAddressProbeDue(canonicalAddress: string, now: number): boolean {
		const entry = this.addressProbeBackoff.get(canonicalAddress);
		return entry === undefined || entry.nextAttempt <= now;
	}

	/**
	 * Record a failed probe of a configured ADDRESS: 30 s × 2^fails, capped at
	 * {@link CONFIGURED_PROBE_BACKOFF_MAX_MS}.
	 *
	 * Paces and nothing more — a configured entry is exempt from eviction and from
	 * quarantine, so this record must never become the evidence that removes one.
	 */
	private noteAddressProbeFailure(canonicalAddress: string): void {
		const failCount = (this.addressProbeBackoff.get(canonicalAddress)?.failCount ?? 0) + 1;
		this.addressProbeBackoff.set(canonicalAddress, { nextAttempt: Date.now() + Math.min(30_000 * 2 ** (failCount - 1), CONFIGURED_PROBE_BACKOFF_MAX_MS), failCount });
	}

	/**
	 * Record a failed recovery dial of a DISCOVERED address against the shared per-peer
	 * backoff, in the same four-field shape every other writer uses.
	 *
	 * Without this the recovery loop was the one dial path that paced nothing: for an
	 * address whose peer is not in the peerStore, re-dial maintenance never sees the peer
	 * either, so a dead entry was re-dialed on every tick for as long as the node stayed
	 * isolated. `evictionFails` deliberately does not grow — at zero connections there is
	 * no evidence the remote is the broken side, which is exactly what
	 * {@link nextEvictionFailCount} resets on.
	 */
	private noteRecoveryDialFailure(peerID: string): void {
		const now = Date.now();
		const previous = this.redialBackoff.get(peerID);
		const failCount = previous?.failCount ?? 0;
		this.redialBackoff.set(peerID, {
			nextAttempt: now + Math.min(30_000 * 2 ** failCount, 600_000),
			failCount: failCount + 1,
			firstFailure: previous?.firstFailure ?? now,
			evictionFails: previous?.evictionFails ?? 0,
		});
		// An expired quarantine is what let this dial through, and it buys exactly one
		// probe: re-arm it on failure or every later pass spends another dial on a peer
		// that has already been written off once.
		if (this.unreachableQuarantine.has(peerID)) this.unreachableQuarantine.set(peerID, now);
	}

	/**
	 * Whether some open connection already terminates on the exact endpoint an address
	 * names.
	 *
	 * The peer-level question — "are we connected to them at all" — is the wrong one for a
	 * per-address probe: a peer reachable through a second address would mask a broken
	 * configured entry for as long as that other route held, which is precisely the case
	 * the probe exists to expose.
	 */
	private hasConnectionOnEndpoint(ma: any): boolean {
		if (!this.node) return false;
		const target = ma.toString();
		try {
			return this.node.getConnections().some(c => isSameDialEndpoint(String(c.remoteAddr ?? ''), target));
		} catch {
			return false;
		}
	}

	private async runZeroConnectionRecovery(epoch: number = this.runEpoch): Promise<void> {
		const node = this.node;
		if (!node || epoch !== this.runEpoch) return;
		// Read connectivity here rather than trusting the snapshot the status tick opened
		// with: re-dial maintenance runs in between and may already have reconnected us,
		// in which case the node is not isolated and every dial below is pure churn.
		if (!AUTODIAL_WORKAROUND || node.getPeers().length !== 0 || this.bootstrapMultiaddrs.length === 0) return;
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
			const pid = extractDestinationPeerID(ma);
			if (pid && this.isRedialSuppressed(pid)) continue; // deliberately left — don't resurrect it here
			// A CONFIGURED entry is the user's way back in, so it is never held back by the
			// quarantine or by the per-peer eviction backoff — but it is still paced, on its
			// own much shorter ADDRESS-level window. Without any pacing, several dead
			// configured entries at a 10 s timeout each turn one tick into minutes of
			// back-to-back dialing, every tick.
			//
			// A DISCOVERED entry earned its place here by answering once, which is no reason
			// to bypass the pacing re-dial maintenance applies to it. Without that, an
			// isolated node re-dialed a dead discovered peer every 30 s forever, since
			// maintenance stops counting failures the moment we have no other connection to
			// prove we are online.
			const canonical = normalizeMultiaddrForCompare(ma.toString());
			const configured = this.configuredBootstrapAddresses.has(canonical);
			if (configured) {
				if (!this.isAddressProbeDue(canonical, Date.now())) continue;
			} else if (pid && !isRecoveryDialDue(pid, Date.now(), this.redialBackoff, this.unreachableQuarantine)) {
				continue;
			}
			// Routability is re-checked here, not just at configure time: a LAN or VPN
			// bootstrap is on this list while its interface is down, and becomes dialable
			// again the moment it returns.
			if (shouldDenyDial(ma, getLocalCidrs())) continue;
			const maStr = ma?.toString?.() ?? String(ma);
			// Each dial awaits for up to 10s, so a stop() can land mid-loop; the
			// remaining dials belong to a node this run no longer owns.
			if (epoch !== this.runEpoch) return;
			// The whole point of this loop is isolation. A dial from an earlier pass that
			// resolved late, or an inbound connection, ends it — carrying on would open
			// connections the node no longer needs.
			if (node.getPeers().length > 0) return;
			try {
				console.log(`   → Dialing ${maStr}`);
				await node.dial(ma, { signal: AbortSignal.timeout(10000) });
				if (epoch !== this.runEpoch) return;
				if (configured) this.addressProbeBackoff.delete(canonical);
				else if (pid) this.redialBackoff.delete(pid);
				console.log(`   ✓ Connected via ${maStr}`);
				break;
			} catch (err: any) {
				if (epoch !== this.runEpoch) return;
				if (configured) this.noteAddressProbeFailure(canonical);
				else if (pid) this.noteRecoveryDialFailure(pid);
				console.log(`   ✗ Failed ${maStr}: ${err.message ?? err}`);
			}
		}
	}

	/**
	 * Slowly re-probe CONFIGURED bootstrap addresses that nothing else will reach.
	 *
	 * An address the routability filter rejected at configure time — a LAN or VPN
	 * bootstrap whose interface was down — never entered the peerStore, so re-dial
	 * maintenance (which walks the peerStore) has no candidate for it. Zero-connection
	 * recovery would pick it up, but only while the node has NO connections at all, so a
	 * node happily talking to someone else would never notice the tunnel came back.
	 *
	 * Runs on the slow promote cadence and paces itself per ADDRESS, so a permanently
	 * broken entry costs one dial per window and cannot starve a sibling address of the
	 * same peer that does work.
	 */
	private async probeParkedConfiguredBootstraps(epoch: number = this.runEpoch): Promise<void> {
		const node = this.node;
		if (!node || epoch !== this.runEpoch) return;
		const localCidrs = getLocalCidrs();
		for (const ma of [...this.bootstrapMultiaddrs]) {
			if (epoch !== this.runEpoch) return;
			const canonical = normalizeMultiaddrForCompare(ma.toString());
			if (!this.configuredBootstrapAddresses.has(canonical)) continue;
			const pid = extractDestinationPeerID(ma);
			if (pid && this.isRedialSuppressed(pid)) continue;
			// Still unreachable from here — leave it parked for a later pass.
			if (shouldDenyDial(ma, localCidrs)) continue;
			if (!this.isAddressProbeDue(canonical, Date.now())) continue;
			// Only a connection ON THIS ENDPOINT answers the question the probe asks. A
			// connection to the same peer over some other address used to skip it, which
			// is exactly how a broken configured entry kept looking fine.
			if (this.hasConnectionOnEndpoint(ma)) continue;
			try {
				// Forced for the same reason the configured branch of addBootstrapPeers
				// forces: without it libp2p hands back whatever connection it already holds
				// to this peer and the probe proves nothing about the address.
				await node.dial(ma, { signal: AbortSignal.timeout(10000), force: true });
				if (epoch !== this.runEpoch) return;
				this.addressProbeBackoff.delete(canonical);
				// Tell the UI as well. This probe is the ONLY thing that retries an address
				// the routability filter rejected at configure time, so without this the row
				// written when the interface was down stayed red for as long as the node ran,
				// however long the address had since been working.
				this.bootstrapTracker.recordAddressReachable(ma.toString());
				console.log(`[NET] parked configured bootstrap reachable again: ${ma.toString()}`);
			} catch (err: any) {
				if (epoch !== this.runEpoch) return;
				this.noteAddressProbeFailure(canonical);
				trace(`[NET] parked configured bootstrap still failing: ${ma.toString()} — ${err?.message ?? err}`);
			}
		}
	}

	private async maybePromotePeers(epoch: number = this.runEpoch): Promise<void> {
		// Every 5th status tick (~150 s at 30 s status cadence) promote every
		// CONNECTED peer back to bootstrap priority (KEEP_ALIVE re-stamp + gossipsub
		// direct set). Disconnected peers are handled by runRedialMaintenance.
		this.statusTickCount++;
		if (this.statusTickCount % 5 === 0) {
			try {
				// Same slow cadence: an address parked as unroutable has no other loop
				// that would ever notice its interface came back.
				await this.probeParkedConfiguredBootstraps(epoch);
			} catch (err: any) {
				trace(`[NET] probeParkedConfiguredBootstraps failed: ${err?.message ?? err}`);
			}
			try {
				await this.promoteKnownPeersToBootstrap(epoch);
			} catch (err: any) {
				trace(`[NET] promoteKnownPeersToBootstrap failed: ${err?.message ?? err}`);
			}
		}
	}

	/**
	 * Promote every CONNECTED peer back to bootstrap priority: KEEP_ALIVE tagging,
	 * bootstrap dedup-set membership, and gossipsub direct-set fast reconnect.
	 * Disconnected peers are deliberately excluded — runRedialMaintenance already
	 * dials each of them every tick with exponential backoff and eviction, whereas
	 * promotion dials have no backoff, so including them meant a burst of dials to
	 * dead peers every promotion cycle and their permanent growth in the direct set.
	 * Runs every ~150 s from the status tick.
	 */
	private async promoteKnownPeersToBootstrap(epoch: number = this.runEpoch): Promise<void> {
		if (!this.node) return;
		const allPeers = await this.node.peerStore.all();
		// stop() may have landed while peerStore.all() was pending — promoting now
		// would repopulate bootstrap/tracker state the shutdown just cleared (or,
		// after a fast restart, populate the NEXT node from the old snapshot).
		if (epoch !== this.runEpoch) return;
		const myID = this.node.peerId.toString();
		const connectedIDs = new Set(this.node.getPeers().map((p: any) => p.toString()));
		const maStrings: string[] = [];
		for (const peer of allPeers) {
			const pid = peer.id.toString();
			if (pid === myID) continue;
			if (!connectedIDs.has(pid)) continue;
			if (this.isRedialSuppressed(pid)) continue; // deliberately left — don't promote it back to bootstrap
			if (this.bootstrapPeerIDs.has(pid)) continue;
			if (peer.addresses.length === 0) continue;
			const addr = peer.addresses[0]!;
			const base = addr.multiaddr.toString();
			// Ensure the address terminates in THIS peer's /p2p/<id> — a bare address
			// gets the suffix appended, and so does a relay address whose only /p2p/
			// component is the relay's own identity.
			const maStr = extractDestinationPeerID(addr.multiaddr) === pid ? base : `${base}/p2p/${pid}`;
			maStrings.push(maStr);
		}
		if (maStrings.length > 0) {
			trace(`[NET] periodic autodial: promoting ${maStrings.length} connected peer(s) to bootstrap`);
			await this.addBootstrapPeers(maStrings);
			if (epoch !== this.runEpoch) return;
		}
		// Also insert every connected peer into the gossipsub `direct` Set at runtime.
		// Direct peers have their own fast reconnect cadence (directConnectTicks ×
		// heartbeatInterval). KEEP_ALIVE handles the TCP layer; gossipsub.direct
		// handles the gossipsub-stream layer. Evicted peers are removed from the
		// set in purgeStalePeer, so it no longer grows monotonically.
		let added = 0;
		for (const peer of allPeers) {
			const pid = peer.id.toString();
			if (pid === myID) continue;
			if (!connectedIDs.has(pid)) continue;
			if (this.addGossipsubDirectPeer(pid)) added++;
		}
		if (added > 0) trace(`[NET] gossipsub direct: added ${added} connected peer(s) to fast-reconnect set`);
	}

	/**
	 * Put a peer into the gossipsub `direct` set — never PRUNEd, and reconnected on its
	 * own fast cadence (directConnectTicks × heartbeatInterval). Removed again by
	 * {@link purgeStalePeer}. Returns whether this call was the one that added it.
	 *
	 * A left-network peer that lingers or reappears in the peerStore is refused: the fast
	 * reconnect cadence would undo the leave-network disconnect.
	 */
	private addGossipsubDirectPeer(peerID: string): boolean {
		const gossipsub: any = this.pubsub;
		if (!gossipsub?.direct || typeof gossipsub.direct.add !== 'function') return false;
		if (this.isRedialSuppressed(peerID)) return false;
		if (gossipsub.direct.has(peerID)) return false;
		gossipsub.direct.add(peerID);
		return true;
	}

	/** Undo {@link addGossipsubDirectPeer}: no more never-PRUNE, no more fast redial. */
	private removeGossipsubDirectPeer(peerID: string): void {
		const gossipsub: any = this.pubsub;
		if (gossipsub?.direct && typeof gossipsub.direct.delete === 'function') gossipsub.direct.delete(peerID);
	}

	/**
	 * Drop the KEEP_ALIVE tag a bootstrap entry earned by answering a dial.
	 *
	 * libp2p re-dials anything carrying a keep-alive tag and the connection manager will
	 * not evict it, so a configured entry the user has deleted stays pinned for the life
	 * of the run unless the tag goes with it. Kept if a joined network still wants the
	 * peer — the tag is then no longer the bootstrap lifecycle's to take away.
	 *
	 * The merge is bound to the node captured here rather than `this.node`, so a restart
	 * landing in it cannot untag the same identity on the successor run.
	 */
	private clearBootstrapKeepAlive(peerID: string): void {
		const node = this.node;
		if (!node) return;
		if (this.isPeerNeededByJoinedNetwork(peerID)) return;
		void (async (): Promise<void> => {
			try {
				await node.peerStore.merge(peerIDFromString(peerID), { tags: { [KEEP_ALIVE]: undefined } });
			} catch (err: any) {
				trace(`[NET] clearBootstrapKeepAlive failed for ${peerID.slice(0, 16)}: ${err?.message ?? err}`);
			}
		})();
	}

	// =========================================================================
	// Runtime state
	// =========================================================================

	/**
	 * Whether the node is running.
	 */
	isRunning(): boolean {
		return this.lifecycle === 'running';
	}

	/**
	 * Whether a failed {@link stop} is PERMANENT.
	 *
	 * True means libp2p itself could not be stopped: it cannot resume an interrupted stop, so
	 * every later `stop()` is refused and only a process restart clears the state. False after
	 * a failed stop means the node is provably down and the failure was in the cleanup that
	 * follows it, which a retried `stop()` completes.
	 *
	 * NEITHER answer makes the instance usable: a failed stop leaves the lifecycle `failed`,
	 * which refuses `start()` and reads as not running. A shutdown that came through
	 * {@link cancelRunOperations} has also left {@link dialAbort} aborted, and only a start
	 * installs a fresh one — so for that caller anything dial-shaped now ends the moment it
	 * begins. This exists only so a caller can say whether retrying the stop is worth
	 * anything.
	 */
	isStopTerminal(): boolean {
		return this.nodeStopUnrecoverable;
	}

	/** Current start/stop phase. Exposed for tests and diagnostics. */
	getLifecycle(): NetworkLifecycle {
		return this.lifecycle;
	}

	/**
	 * The run this node instance belongs to — see {@link runEpoch}.
	 *
	 * For a caller whose SEQUENCE of destructive calls has to answer to one node: taking the
	 * default epoch per call binds each of them to whatever run is current at that moment, so
	 * a sequence that outlives a stop finishes against the node that replaced it.
	 */
	getRunEpoch(): number {
		return this.runEpoch;
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
	 * peer-announce gossip passes the networkID of the topic the announce arrived
	 * on, so discovered peers are tracked per-network too. Pass `null` only for
	 * additions with no owning network, in which case stats are skipped.
	 *
	 * Reports whether the whole list was PROCESSED — see {@link BootstrapDialResult}. A
	 * caller that records what it installed needs to know the difference: an address the
	 * loop never reached is not installed and no comparison of lists will ever say so.
	 */
	async addBootstrapPeers(peers: string[], networkID: string | null = null, origin: BootstrapPeerOrigin = 'discovered'): Promise<BootstrapDialResult> {
		// Group the run's status writes. Intake performs two per address — a pending mark
		// and an outcome — and each rebuilds and publishes the network's whole peer list,
		// so one 128-address announce used to cost 256 snapshots and 256 WebSocket pushes
		// of which the UI kept the last. The frame flushes periodically rather than only
		// at close, so a list of slow dials still reports progress as it goes.
		if (networkID === null) return this.dialBootstrapEntries(peers, networkID, origin);
		return await this.bootstrapTracker.batchDebounced(networkID, () => this.dialBootstrapEntries(peers, networkID, origin));
	}

	/**
	 * Abandon this run's outstanding network work, without stopping the node.
	 *
	 * For a shutdown that WAITS for the operations already under way. Neither half of that
	 * work ends by itself: a join parked on a sequential walk of unreachable bootstrap
	 * addresses costs one connection timeout per address, and a leave's per-peer teardown
	 * awaits a `hangUp` and peerStore writes that have no deadline at all — so a single
	 * unresponsive peer used to hold the shutdown, and the catalog behind it, indefinitely.
	 *
	 * Idempotent, and only ever the current run: {@link start} installs a fresh controller.
	 */
	cancelRunOperations(): void {
		this.dialAbort.abort();
	}

	/** The dial loop behind {@link addBootstrapPeers}; see there for the batching wrapper. */
	private async dialBootstrapEntries(peers: string[], networkID: string | null, origin: BootstrapPeerOrigin): Promise<BootstrapDialResult> {
		if (!this.node) {
			console.error('Network not started - cannot add bootstrap peers');
			return 'incomplete';
		}
		const myPeerID = this.node.peerId.toString();
		const localCidrs = getLocalCidrs();
		// Fire-and-forget callers (peer-announce intake, startup joins) run outside
		// the status-tick epoch guard. Capture the epoch so a dial that settles after
		// a stop()/restart cannot record outcomes on the cleared tracker or write
		// peerStore state for the NEXT node instance.
		//
		// The generation covers the other axis: the node stays up but THIS network's
		// bootstrap list is replaced, reset or left while we are part-way down it. The
		// loop dials sequentially and one dial can take seconds, so an old job would
		// otherwise keep walking the old list — re-adding entries the user has just
		// removed and re-marking them configured, which exempts them from the stale
		// sweep until restart. Exactly the resurrection this eviction work exists to
		// prevent.
		const epoch = this.runEpoch;
		// Captured, not re-read: the claims this run takes have to be released back into
		// the same object it took them from, whatever teardown has since put in the field.
		const inFlight = this.inFlightBootstrapDials;
		const generation = this.bootstrapGenerationOf(networkID);
		// Captured for the same reason as the epoch: this loop answers to the run it started
		// on, and a controller replaced by a later start is not the one that can stop it.
		const abort = this.dialAbort;
		const superseded = (): boolean => epoch !== this.runEpoch || abort.signal.aborted || generation !== this.bootstrapGenerationOf(networkID);
		for (const peer of peers) {
			if (superseded()) return 'incomplete';
			let probeAfterQuarantine = false;
			try {
				const ma = Multiaddr(peer);
				// Claim the configured status BEFORE the routability filter. Whether an address
				// is dialable is a property of THIS HOST right now — a LAN or VPN bootstrap stops
				// passing the filter the moment that interface drops — while "the user configured
				// this peer" is a fact about the saved config. Deriving the second from the first
				// left a VPN bootstrap unregistered whenever the tunnel was down at startup, so the
				// exemption that makes configured peers un-evictable never applied to it.
				const peerID = extractDestinationPeerID(ma);
				// Skip our own address — compare the DESTINATION identity, not the raw
				// string: `/p2p/<us>/p2p-circuit/p2p/<remote>` contains our ID as the
				// relay hop yet targets a remote peer and must not be dropped as self.
				if (peerID === myPeerID) continue;
				// What this address IS outranks what this caller calls it. The status tracker
				// already keeps the stronger classification when a row is overwritten, so a
				// gossip re-announcement of an address the user configured lands on a
				// CONFIGURED row — and the dial has to follow the same rule or the two
				// disagree. They did: the announce dialed without `force`, libp2p handed back
				// the connection the peer happened to hold on a DIFFERENT address, and the
				// discovered branch recorded 'connected' on a configured row whose address had
				// never been contacted. The user then saw a green light on a broken entry.
				const canonicalAddress = normalizeMultiaddrForCompare(ma.toString());
				const effectiveOrigin: BootstrapPeerOrigin = origin === 'configured' || this.configuredBootstrapAddresses.has(canonicalAddress) ? 'configured' : 'discovered';
				// Claiming the peer as configured stays keyed on what the CALLER declared:
				// this branch also lifts leave-network suppression, which is the user's
				// decision to reverse, never gossip's.
				if (peerID && origin === 'configured') {
					this.configuredBootstrapPeerIDs.add(peerID);
					// A re-configured bootstrap peer means its network was (re-)joined — it
					// is no longer "left", so lift any redial suppression left by a prior
					// leaveNetwork, otherwise maintenance would skip it forever if this one
					// explicit dial fails or the connection drops before the next tick.
					this.clearRedialSuppressionForPeer(peerID);
				}
				// Also before the routability filter: a LAN or VPN bootstrap is unroutable only
				// while its interface is down, and keeping it off the recovery list until then
				// means nothing retries it when the tunnel returns. Recovery re-checks
				// routability itself before dialing.
				// The autodial list is a different promise: zero-connection recovery walks
				// it and dials everything on it. A CONFIGURED address belongs there at once
				// — it is user data and recovery must keep trying it precisely while it is
				// down. A DISCOVERED address is only a claim some peer made, so it earns
				// its place by answering; it is added after a verified dial, below. Adding
				// it here left every unreachable address a gossip flood could invent on the
				// list for good, since an ordinary timeout has nothing that takes it off.
				if (origin === 'configured') {
					this.configuredBootstrapAddresses.add(canonicalAddress);
					this.rememberBootstrapAddress(ma);
				}
				// Safety net: refuse to dial loopback / unreachable-private bootstrap entries
				// even if the upstream (catalog or peer-announce intake) failed to filter them.
				// A discovered address is dropped silently — the call site iterates many
				// candidates and should not spam INFO for each. A configured one gets a status
				// row instead: the user wrote it down and needs to see why nothing happens with it.
				if (shouldDenyDial(ma, localCidrs)) {
					trace(`[NET] addBootstrapPeers skip non-routable: ${peer}`);
					if (effectiveOrigin === 'configured') this.bootstrapTracker.recordOutcome(networkID, peer, peerID, 'error', 'address is not routable from this host', null, effectiveOrigin);
					continue;
				}
				// Pacing, before the quarantine is consulted: gossip mentions a dead peer
				// on every announce cycle, and this path used to answer each one with a
				// fresh 10 s dial because it read the quarantine and nothing else. The
				// backoff is the record every other dial path already waits on, and
				// checking it FIRST matters — an expired quarantine buys exactly one probe,
				// which must not be spent by a dial the backoff was going to refuse.
				if (peerID && effectiveOrigin === 'discovered') {
					const backoff = this.redialBackoff.get(peerID);
					if (backoff !== undefined && backoff.nextAttempt > Date.now()) {
						trace(`[NET] addBootstrapPeers skip backoff: ${peerID.slice(0, 16)}`);
						continue;
					}
				}
				// Skip peers recently evicted as unreachable — nodes that still remember
				// them keep gossiping their addrs, and without this window every mention
				// would re-create the status row and burn a dial. Configured entries are
				// exempt: the user asked for them explicitly.
				if (peerID && effectiveOrigin === 'discovered') {
					const quarantinedAt = this.unreachableQuarantine.get(peerID);
					if (quarantinedAt !== undefined) {
						if (Date.now() - quarantinedAt < UNREACHABLE_QUARANTINE_MS) {
							trace(`[NET] addBootstrapPeers skip quarantined: ${peerID.slice(0, 16)}`);
							continue;
						}
						this.unreachableQuarantine.delete(peerID);
						// This dial is the ONE probe an expired quarantine buys. If it fails the
						// window has to close again — otherwise every later gossip mention spends
						// another dial and refreshes the status row, which is exactly the churn
						// the quarantine exists to stop.
						probeAfterQuarantine = true;
					}
				}
				// Single-flight, keyed by the endpoint rather than the peer: two addresses of
				// one peer are two different questions and both deserve their own dial, while
				// two runs asking about the SAME address duplicate a 10 s timeout for one
				// answer. Claimed after every skip above so a refused candidate never blocks
				// the run that would actually dial it.
				if (inFlight.has(canonicalAddress)) {
					trace(`[NET] addBootstrapPeers skip in-flight: ${peer}`);
					continue;
				}
				inFlight.add(canonicalAddress);
				// A CONFIGURED identity is user data and enters the set on the strength of the
				// saved config alone. A DISCOVERED one waits for the dial: it arrived in a
				// gossip message and nothing has yet shown that the identity exists, let
				// alone that it is the one behind this address. Admitting it here put every
				// peer ID any topic subscriber cared to name into an unbounded global set —
				// one that nothing prunes, and that other code reads as "this peer is
				// handled". Deduplication of repeated mentions is not this set's job and
				// never was: {@link inFlightBootstrapDials} and the backoff above do that.
				if (peerID && origin === 'configured') this.bootstrapPeerIDs.add(peerID);
				console.debug('Adding bootstrap peer:', peer);
				this.bootstrapTracker.markPending(networkID, peer, peerID, effectiveOrigin);
				try {
					// Always hand the address to libp2p and let IT decide whether a dial is
					// needed. Skipping the call whenever any connection to the peer existed
					// was too coarse: libp2p reuses only a DIRECT, unlimited connection, and
					// deliberately dials when it holds a relayed one and the new address
					// would upgrade it to direct. Pre-empting that cost us the upgrade, and
					// left a bad configured address permanently untested — its identity
					// mismatch undiscovered — whenever the peer happened to be reachable
					// some other way.
					//
					// The address may still enter the address book only when it is
					// Noise-verified, otherwise a topic subscriber could poison a connected
					// peer's addresses with entries that later feed re-dials and eviction.
					// Verification is now read off the RESULT: the connection libp2p handed
					// back is proof for `ma` only if that is the address it is actually on.
					// A configured address is the user's own claim and its status row is how
					// they debug it, so it gets a real probe: `force` makes libp2p contact
					// THIS address instead of handing back a connection it already holds to
					// the same peer, which is what let a broken configured entry sit there
					// showing "connected" — and kept its identity mismatch undiscovered —
					// merely because the peer was reachable some other way.
					//
					// Discovered addresses never force: they arrive from gossip, and a peer
					// that names many of them could otherwise make us open a connection per
					// address. For those, libp2p's own reuse is the desired behaviour.
					const pidObj = peerID ? peerIDFromString(peerID) : null;
					// The signal is what makes a shutdown able to WAIT for this loop instead of
					// racing it: without it, abandoning the run still leaves the current dial
					// running to its full timeout, and a list of unreachable addresses costs
					// that many timeouts before anyone can stop the node.
					const conn = await this.node.dial(ma, effectiveOrigin === 'configured' ? { force: true, signal: abort.signal } : { signal: abort.signal });
					const verifiedThisAddr = isSameDialEndpoint(String(conn?.remoteAddr ?? ''), ma.toString());
					// A dial already in flight cannot be called back: hangUp only closes
					// connections that ALREADY exist, so a leave-network landing mid-dial finds
					// nothing to close and this connection surfaces a moment after the cleanup
					// finished. Abandoning the loop would leave it open, so close it here — the
					// suppression set is what says the user deliberately left this peer.
					// Two ways this connection can already be unwanted: the peer was hung up
					// by leave-network and sits in the suppression set, or we left the network
					// this dial belonged to before ever seeing the peer as one of its members,
					// in which case it never entered that set at all.
					//
					// The EPOCH is checked first and separately from the full `superseded()`:
					// a different node instance means none of this run's suppression or
					// subscription state describes the node that would be torn at, so the
					// destructive branch must not run at all. A bumped GENERATION is the
					// opposite case — the network was left or its list replaced on the SAME
					// node, which is precisely when this connection needs closing, so it may
					// not short-circuit ahead of it.
					if (epoch !== this.runEpoch) return 'incomplete';
					if (peerID && networkID && (this.isRedialSuppressed(peerID) || !this.isTopicSubscribed(networkID)) && !this.isPeerNeededByJoinedNetwork(peerID)) {
						trace(`[NET] bootstrap dial landed after leave, disconnecting: ${peerID.slice(0, 16)}`);
						await this.disconnectPeer(peerID, networkID, epoch);
						return 'incomplete';
					}
					if (superseded()) return 'incomplete';
					// The peer answered, so the identity behind this address is real and
					// wanted — the point at which a discovered ID has earned its place in
					// the set (see the claim above for why it may not have it yet).
					if (peerID) this.bootstrapPeerIDs.add(peerID);
					// A CONFIGURED bootstrap joins the gossipsub direct set the moment it
					// answers. Production starts the node with an empty list — the config-time
					// `directPeers` seed never applies — so waiting for the periodic promotion
					// left the peer the whole mesh depends on without a fast reconnect, and
					// PRUNE-able, for the first ~150 s of every run.
					if (peerID && effectiveOrigin === 'configured') this.addGossipsubDirectPeer(peerID);
					if (pidObj) {
						await this.node.peerStore.merge(pidObj, verifiedThisAddr ? { multiaddrs: [ma], tags: { [KEEP_ALIVE]: { value: 1 } } } : { tags: { [KEEP_ALIVE]: { value: 1 } } });
					}
					// Re-check after the merge await too: stop() may have cleared the
					// tracker while it was pending, and recordOutcome would otherwise
					// resurrect a network row for the old (or next) node instance.
					if (superseded()) return 'incomplete';
					// `force: true` defeats connection REUSE, but not a dial to the same peer
					// ID already in libp2p's queue: this call joins that job and can be handed
					// the connection its other address won. For a CONFIGURED entry the row
					// means "this address works", so an unverified dial must leave it pending
					// rather than turn it green — a wrong address that the peer happens to
					// survive through another route is exactly what the row exists to expose.
					// Discovered rows carry the weaker "the peer answered" meaning and are
					// recorded either way.
					if (effectiveOrigin === 'configured' && !verifiedThisAddr) {
						trace(`[NET] bootstrap addr unverified (connection came back on another address), left pending: ${peer}`);
						continue;
					}
					// A gossip-learned address has now answered on the endpoint it claimed, so
					// it has earned its place in the autodial list. Unverified ones never get
					// there, which is what keeps a flood of invented addresses off it.
					if (effectiveOrigin === 'discovered' && verifiedThisAddr) this.rememberBootstrapAddress(ma);
					// The identity Noise actually proved on this connection, not the one the
					// address claimed. It is the only evidence the row-cap ranking accepts, and
					// passing null here left an active, verified member ranked as an ordinary
					// connected row — evictable by age alongside the invented addresses the
					// ranking exists to drop.
					this.bootstrapTracker.recordOutcome(networkID, peer, peerID, 'connected', null, conn?.remotePeer?.toString() ?? null, effectiveOrigin);
					console.log('✓ Connected to new bootstrap peer');
				} catch (err: any) {
					if (superseded()) return 'incomplete';
					const message = err?.message ?? String(err);
					const kind = classifyBootstrapError(message);
					// The probe the expired quarantine allowed has failed, so close the window
					// again rather than letting the next announce buy another dial.
					if (probeAfterQuarantine && peerID) this.unreachableQuarantine.set(peerID, Date.now());
					// Pay the failure into the shared per-peer backoff the check above reads.
					// Without this the check could never bite for a gossip-learned peer: nothing
					// else writes that record for a peer absent from the peerStore, so re-dial
					// maintenance never sees it either and every announce bought another dial.
					// Same accounting as the recovery loop — pacing only, no eviction credit,
					// since a failed announce dial says nothing about who is the broken side.
					if (peerID && effectiveOrigin === 'discovered') this.noteRecoveryDialFailure(peerID);
					const actualPeerID = kind === 'identity-mismatch' ? extractActualPeerID(message) : null;
					this.bootstrapTracker.recordOutcome(networkID, peer, peerID, kind, message, actualPeerID, effectiveOrigin);
					// [NET-MISMATCH] richer log for identity-mismatch — single line containing
					// origin (configured / discovered from peer-announce), multiaddr,
					// expected peerID and the actual peerID Noise reported. Makes it
					// trivial to grep `[NET-MISMATCH]` and diff what the catalog has
					// vs reality, even before the UI shows the same data.
					if (kind === 'identity-mismatch') {
						console.log(`[NET-MISMATCH] origin=${effectiveOrigin} net=${networkID?.slice(0, 8) ?? 'none'} addr=${peer} expected=${peerID ?? 'none'} actual=${actualPeerID ?? 'unparsed'}`);
					} else {
						console.log(`⚠️  Could not connect to bootstrap peer (${kind}): ${peer} — ${message}`);
					}
					// Crypto-verified identity mismatch ⇒ THIS ADDRESS provably no longer
					// belongs to the expected peer (Noise is unforgeable). It says nothing
					// about the peer's other addresses: a peer healthy over a relay can
					// still have one stale direct address that some other node now owns.
					// So: peer alive through other connections → drop only the offending
					// address; peer with no connections → full purge as before.
					if (kind === 'identity-mismatch' && peerID) {
						const pid = peerIDFromString(peerID);
						// Compare in a form that survives both multiaddr normalization (expanded →
						// compressed IPv6) and DNS case / trailing-dot differences — otherwise a
						// filter that fails to match silently keeps the poisoned address while
						// logging that it was dropped.
						const canonical = normalizeMultiaddrForCompare(ma.toString());
						const canonicalBare = canonical.replace(/\/p2p\/[^/]+$/, '');
						const matches = (str: string): boolean => {
							const n = normalizeMultiaddrForCompare(str);
							return n === canonical || n === canonicalBare;
						};
						// Noise proves exactly one thing: THIS address no longer leads to the peer
						// we expected. It says nothing about the peer's other addresses, so the bad
						// one goes first and unconditionally — whether or not the peer happens to be
						// connected right this moment. Purging on "not currently connected" threw
						// away addresses that were never disproved.
						// Restrict the autodial-list filter to entries of THIS peer so a
						// case-insensitive compare can never drop a different peer's addr.
						this.bootstrapMultiaddrs = this.bootstrapMultiaddrs.filter(m => extractDestinationPeerID(m) !== peerID || !matches(m.toString()));
						let remainingAddresses = 0;
						try {
							const rec = await this.node.peerStore.get(pid);
							const keep = rec.addresses.filter((a: any) => !matches(a.multiaddr.toString()));
							if (keep.length < rec.addresses.length) await this.node.peerStore.patch(pid, { multiaddrs: keep.map((a: any) => a.multiaddr) });
							remainingAddresses = keep.length;
						} catch {
							/* peer not in store — nothing to trim, and nothing left either */
						}
						if (superseded()) return 'incomplete';
						// Only once the peer has neither a live connection nor a single address we
						// have not disproved is there anything left to purge.
						if (this.node.getConnections(pid).length === 0 && remainingAddresses === 0) {
							await this.purgeStalePeer(peerID, `${effectiveOrigin} dial identity mismatch, no usable address left`, epoch);
						} else {
							console.log(`[NET] dropped stale addr of peer ${peerID.slice(0, 16)}: ${ma.toString()}`);
						}
						// For DISCOVERED entries (peer-announce gossip), also drop the
						// status entry — there's no saved config row to "fix" and leaving
						// it visible just adds UI noise. For CONFIGURED entries, keep
						// it so the user can decide to update or remove the saved row.
						if (effectiveOrigin === 'discovered' && networkID) {
							this.bootstrapTracker.deletePeer(networkID, peer);
						}
					}
				} finally {
					// Every exit from the dial block releases the claim, `return` included —
					// a leave landing mid-dial would otherwise lock the address out for the
					// lifetime of the node.
					inFlight.delete(canonicalAddress);
				}
			} catch (error: any) {
				this.bootstrapTracker.recordOutcome(networkID, peer, null, 'error', error?.message ?? String(error), null, origin);
				console.log('⚠️  Skipping invalid multiaddr:', peer, '-', error.message);
			}
		}
		return 'completed';
	}

	/**
	 * Set a callback for per-network bootstrap status updates. Called whenever
	 * `addBootstrapPeers(_, networkID)` records a new outcome for any entry.
	 */
	set onBootstrapStatusChange(cb: ((networkID: string, status: BootstrapStatus) => void) | null) {
		this.bootstrapTracker.setOnChange(cb);
	}

	/**
	 * True when this node holds a live connection to somebody OTHER than the given
	 * peer.
	 *
	 * It tells a total local outage from a working link, no more than that: a host whose
	 * VPN dropped still answers true off its LAN connections. So it can only ever DISCOUNT
	 * evidence — a dial that failed while we could reach nobody proves nothing about the
	 * peer — and never stand in for evidence on its own. Eviction is decided by the dial
	 * failures themselves; this is the veto over counting them.
	 *
	 * The peer being judged is excluded because a connection to it would make the question
	 * moot — that case is handled separately, right before the purge.
	 */
	private hasConnectionOtherThan(peer: PeerID): boolean {
		return !!this.node && this.node.getConnections().some(connection => !connection.remotePeer.equals(peer));
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
	 *
	 * `epoch` binds the call to the node instance it was started for. This is the most
	 * destructive path there is — it closes connections and deletes peerStore entries —
	 * and it awaits in the middle, so a stop()/start() landing between those awaits
	 * would otherwise let it finish against the NEXT node and evict a peer that
	 * instance never had a problem with. The node reference is captured once for the
	 * same reason: re-reading `this.node` after an await can hand back a different node.
	 */
	async purgeStalePeer(peerID: string, reason: string, epoch: number = this.runEpoch): Promise<void> {
		const node = this.node;
		if (!node || epoch !== this.runEpoch) return;
		this.bootstrapPeerIDs.delete(peerID);
		// Drop the peer's addrs from the autodial list too — this array is otherwise
		// push-only, so the zero-connection recovery loop would keep dialing addrs
		// of an identity we just proved dead, and the array would grow until stop().
		this.bootstrapMultiaddrs = this.bootstrapMultiaddrs.filter(ma => extractDestinationPeerID(ma) !== peerID);
		// Remove from the gossipsub never-PRUNE direct set, or gossipsub keeps
		// attempting a direct stream to the dead peer every directConnectTicks.
		this.removeGossipsubDirectPeer(peerID);
		this.redialBackoff.delete(peerID);
		try {
			const pid = peerIDFromString(peerID);
			// Drop existing connections so libp2p considers the entry fully gone.
			const conns = node.getConnections(pid);
			for (const c of conns) {
				try {
					await c.close();
				} catch {
					/* connection may already be closing */
				}
			}
			// Closing connections yields; bail before the irreversible delete if this
			// run no longer owns the node.
			if (epoch !== this.runEpoch) return;
			await node.peerStore.delete(pid);
			console.log(`[NET] purged stale peerStore entry ${peerID.slice(0, 16)}… (reason: ${reason})`);
			// TOCTOU healing: an inbound connection can land between the caller's
			// liveness check and the delete above. The peer:connect handler resets
			// failure counters but cannot restore the bootstrap/keep-alive state this
			// purge just removed — so if the peer is connected NOW, rebuild its dial
			// state from the live connections; otherwise reconnect would silently die
			// with the first drop.
			//
			// Not for a peer leave-network hung up: it is meant to be forgotten, and a
			// connection racing the purge is not a reason to rebuild what the leave
			// deliberately tore down.
			if (epoch !== this.runEpoch) return;
			const after = node.getConnections(pid);
			if (after.length > 0 && !this.isRedialSuppressed(peerID)) {
				await this.restorePurgedPeerState(node, pid, after, epoch);
			}
		} catch (err: any) {
			trace(`[NET] purgeStalePeer ${peerID.slice(0, 16)} failed: ${err?.message ?? err}`);
		}
	}

	/**
	 * Put back everything {@link purgeStalePeer} took away, for a peer that turns out to
	 * be connected after all.
	 *
	 * The purge removes four things — the bootstrap dedup entry, the peer's addresses
	 * from the autodial list, its gossipsub direct entry and its keep-alive tag — and
	 * restoring only some of them left a state nothing else repairs: periodic promotion
	 * skips any peer already in `bootstrapPeerIDs`, so the missing address and direct
	 * entry would stay missing for as long as the peer stayed connected, and the next
	 * drop would find no way back.
	 *
	 * `bootstrapPeerIDs` is therefore filled in LAST. It is the flag the other paths read
	 * as "this peer is handled"; setting it first is what let promotion observe a
	 * half-restored peer and walk away from it.
	 */
	private async restorePurgedPeerState(node: Libp2p, pid: PeerID, connections: Array<{ remoteAddr: any }>, epoch: number): Promise<void> {
		const peerID = pid.toString();
		this.unreachableQuarantine.delete(peerID);
		await node.peerStore.merge(pid, {
			multiaddrs: connections.map(c => c.remoteAddr),
			tags: { [KEEP_ALIVE]: { value: 1 } },
		});
		if (epoch !== this.runEpoch) return;
		for (const c of connections) {
			// The autodial list is walked by peer ID, so an address that does not already
			// end in this peer's identity gets the suffix — the same shape promotion builds.
			const remote = c.remoteAddr;
			if (!remote) continue;
			try {
				this.rememberBootstrapAddress(extractDestinationPeerID(remote) === peerID ? remote : Multiaddr(`${remote.toString()}/p2p/${peerID}`));
			} catch {
				// Unparseable remote address — nothing to put back on the list for it.
			}
		}
		const gossipsub: any = this.pubsub;
		if (gossipsub?.direct && typeof gossipsub.direct.add === 'function') gossipsub.direct.add(peerID);
		this.bootstrapPeerIDs.add(peerID);
		console.log(`[NET] purge raced an inbound connection — restored ${peerID.slice(0, 16)}…`);
	}

	/**
	 * True if the peer is one we must never voluntarily disconnect because it
	 * provides infrastructure rather than being a plain content peer: an
	 * explicitly configured bootstrap peer, or a relay some of our circuit
	 * connections are routed THROUGH (dropping it would also kill transit for
	 * any NAT'd peers reachable only via that relay).
	 *
	 * Peer-announce-discovered bootstrap entries and peers merely REACHED over
	 * a relay are plain content peers — hanging those up touches only their own
	 * connection, so lishnet leave may disconnect them.
	 *
	 * Used by lishnet leave to decide which topic peers are safe to hang up —
	 * leaving an empty lishnet must not tear down shared bootstrap/relay links
	 * that other still-joined lishnets depend on.
	 */
	/**
	 * Drop a peer from the configured-bootstrap exemption set. Called by the
	 * lishnet layer when a bootstrap entry is removed from config or belongs only
	 * to a lishnet being left, so `isBootstrapOrRelayPeer` stops treating a peer
	 * that is no longer configured (nor shared with another joined network) as
	 * infrastructure that leave-network must keep connected — and so the
	 * unreachable-eviction exemption ends with it.
	 *
	 * Both callers already establish that the peer is configured in NO joined
	 * network before calling, so this needs no refcount of its own.
	 */
	/**
	 * Put an address on the autodial list that zero-connection recovery walks, unless
	 * it is already there.
	 *
	 * Membership is decided by the ADDRESS, not by the peer ID behind it: a bootstrap
	 * whose host or port the user edited keeps its identity, and an identity-keyed
	 * check would treat the new address as already known and never add it — leaving
	 * recovery dialing the address that was replaced.
	 */
	private rememberBootstrapAddress(ma: any): void {
		const canonical = normalizeMultiaddrForCompare(ma.toString());
		if (this.bootstrapMultiaddrs.some(m => normalizeMultiaddrForCompare(m.toString()) === canonical)) return;
		this.bootstrapMultiaddrs.push(ma);
		if (this.bootstrapMultiaddrs.length <= MAX_BOOTSTRAP_ADDRESSES) return;
		// Array order is insertion order, so the first discovered entry is the oldest one.
		// A list of nothing but configured entries is left to grow: it is bounded by what
		// the user saved, and dropping any of it would silently unconfigure a bootstrap.
		const oldestDiscovered = this.bootstrapMultiaddrs.findIndex(m => !this.configuredBootstrapAddresses.has(normalizeMultiaddrForCompare(m.toString())));
		if (oldestDiscovered === -1) return;
		trace(`[NET] autodial list full — dropping ${this.bootstrapMultiaddrs[oldestDiscovered]?.toString()}`);
		this.bootstrapMultiaddrs.splice(oldestDiscovered, 1);
	}

	/**
	 * Take specific addresses off the autodial list. Used when a network's configured
	 * list changes: an entry that is gone must stop being dialed, and that includes
	 * the case where the peer ID stays and only its address moved, which
	 * {@link pruneConfiguredBootstrapPeer} cannot see because the identity is still
	 * configured.
	 */
	pruneBootstrapAddresses(addresses: string[]): void {
		if (addresses.length === 0) return;
		const drop = new Set(addresses.map(a => normalizeMultiaddrForCompare(a)));
		this.bootstrapMultiaddrs = this.bootstrapMultiaddrs.filter(ma => !drop.has(normalizeMultiaddrForCompare(ma.toString())));
		for (const address of drop) {
			this.configuredBootstrapAddresses.delete(address);
			// The pacing record goes with the address it paces. Left behind, it accumulates
			// across every configuration change until stop(), and — worse — a re-added
			// address inherits the old failCount and its multi-minute nextAttempt, so a user
			// who deletes an entry and puts it back may see nothing dialed for minutes.
			this.addressProbeBackoff.delete(address);
		}
	}

	pruneConfiguredBootstrapPeer(peerID: string): void {
		this.configuredBootstrapPeerIDs.delete(peerID);
		// Symmetric with what the configured lifecycle hands out on the way in — a direct-set
		// entry and a KEEP_ALIVE tag, both granted the moment the entry answers a dial.
		// Without the matching removal, a bootstrap edited out of the list kept its fast
		// reconnect cadence and its eviction exemption for the rest of the run: gossipsub
		// went on opening a direct stream to it every directConnectTicks and libp2p went on
		// re-dialing it, so the peer the user deleted never actually went away.
		this.removeGossipsubDirectPeer(peerID);
		this.clearBootstrapKeepAlive(peerID);
		// Forget its addresses too. They were pushed into the autodial list when the
		// entry was first configured, and that list is what zero-connection recovery
		// walks — leaving them there means a bootstrap the user has just deleted keeps
		// being dialed whenever the node runs out of connections, which is exactly the
		// churn this work removes. The dedup set has to let go as well, or a later
		// re-add would be treated as already known and the address could never come back.
		this.bootstrapPeerIDs.delete(peerID);
		// Only the addresses that came from the config. The same peer may also have a
		// gossip-learned address that earned its place by answering a dial — that one
		// belongs to the discovered lifecycle (TTL, backoff) and is not the user's to lose
		// just because they deleted a different address of the same peer.
		this.bootstrapMultiaddrs = this.bootstrapMultiaddrs.filter(ma => {
			if (extractDestinationPeerID(ma) !== peerID) return true;
			const canonical = normalizeMultiaddrForCompare(ma.toString());
			if (!this.configuredBootstrapAddresses.has(canonical)) return true;
			this.configuredBootstrapAddresses.delete(canonical);
			// Same reason as in pruneBootstrapAddresses: the pacing record belongs to the
			// address, so a re-add must not inherit the deleted entry's backoff.
			this.addressProbeBackoff.delete(canonical);
			return false;
		});
	}

	isBootstrapOrRelayPeer(peerID: string): boolean {
		if (this.configuredBootstrapPeerIDs.has(peerID)) return true;
		if (!this.node) return false;
		try {
			// A relay's ID is the hop right before /p2p-circuit in a circuit address:
			// /ip4/../tcp/../p2p/<relayID>/p2p-circuit/p2p/<targetID>
			for (const c of this.node.getConnections()) {
				if (!Circuit.matches(c.remoteAddr)) continue;
				const relayPrefix = c.remoteAddr.toString().split('/p2p-circuit')[0]!;
				if (relayPrefix.endsWith(`/p2p/${peerID}`)) return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	/**
	 * Record a mesh GRAFT as topic membership. GRAFT is the earliest proof a peer is on
	 * a topic — it precedes the peer showing up in getSubscribers and does not wait for
	 * the announce cadence — so this is what lets leave-network hang up a peer the live
	 * snapshot would still be blind to.
	 *
	 * Split out of the listener so a test can feed it a real gossipsub payload: the
	 * event carries `peerId`, and reading it as `peerID` silently records nothing.
	 */
	private noteMeshGraft(detail: MeshPeer | undefined): void {
		const topic = detail?.topic;
		const peerId = detail?.peerId;
		if (!topic?.startsWith(LISH_TOPIC_PREFIX) || !peerId) return;
		this.peerAnnounce.noteMember(topic, peerId);
	}

	/** Recently-seen subscribers of a lishnet's topic (TTL union, not just the live snapshot). */
	getRecentTopicMembers(networkID: string): string[] {
		return this.peerAnnounce.getRecentMembers(lishTopic(networkID));
	}

	/**
	 * True if we currently share at least one joined lishnet topic with the
	 * given peer — i.e. some lish topic WE are subscribed to lists the peer
	 * among its subscribers.
	 *
	 * Coarse serve-gate for unicast LISH discovery: a peer we no longer
	 * share any lishnet with must not be able to browse or search our shared
	 * LISHs just because a transport connection exists (e.g. the peer's
	 * keep-alive re-dialed us right after we left its network).
	 */
	/**
	 * Whether a lishnet we are STILL in has any claim on this peer.
	 *
	 * Leaving one network says nothing about the others — the same peer can be a member
	 * of a second lishnet or its configured bootstrap. Tearing it down is destructive
	 * (disconnectPeer suppresses re-dials AND drops the peerStore entry), so that is
	 * reserved for a peer no joined network has a use for. It is the same question
	 * leaveNetwork asks before it hangs anyone up.
	 */
	private isPeerNeededByJoinedNetwork(peerID: string): boolean {
		if (this.isBootstrapOrRelayPeer(peerID)) return true;
		if (this.sharesJoinedTopicWith(peerID)) return true;
		if (!this.pubsub) return false;
		for (const topic of this.pubsub.getTopics()) {
			if (!topic.startsWith(LISH_TOPIC_PREFIX)) continue;
			// Recently-seen counts as well: a member that is momentarily disconnected is
			// still a member, and leaveNetwork widens its own snapshot the same way.
			if (this.peerAnnounce.getRecentMembers(topic).includes(peerID)) return true;
		}
		return false;
	}

	sharesJoinedTopicWith(peerID: string): boolean {
		if (!this.pubsub) return false;
		for (const topic of this.pubsub.getTopics()) {
			if (!topic.startsWith(LISH_TOPIC_PREFIX)) continue;
			try {
				if (this.pubsub.getSubscribers(topic).some((p: any) => p.toString() === peerID)) return true;
			} catch {
				// topic may be tearing down — treat as not shared
			}
		}
		return false;
	}

	/**
	 * Softer gate for the low-sensitivity shared-LISH LISTING (getLishs) only —
	 * data requests (getLish/getChunk) stay on the strict {@link sharesJoinedTopicWith}
	 * fail-closed gate. {@link sharesJoinedTopicWith} relies on gossipsub's subscriber
	 * view, which lags for a freshly-connected peer whose SUBSCRIBE has not propagated
	 * yet — the exact window the unicast search fallback targets, so the listing must
	 * not be withheld there.
	 *
	 * The soft path is therefore bounded to that window instead of lasting forever.
	 * An unbounded soft gate collapses to "am I in ANY lishnet?", which means a peer
	 * of a lishnet we left keeps listing our shares for as long as we stay in some
	 * other lishnet — redial suppression is then the only thing standing in the way,
	 * so any peer the leave-time disconnect missed still sees everything we share.
	 * Connection age is the discriminator: a peer that has been connected longer than
	 * the propagation window and still shares no joined topic is not a lagging
	 * SUBSCRIBE, it is a peer with no business reading our listing.
	 */
	canListSharesTo(peerID: string): boolean {
		if (this.isRedialSuppressed(peerID)) return false;
		if (!this.pubsub) return false;
		// Not in any lishnet → nothing to list, regardless of who is asking.
		if (!this.pubsub.getTopics().some((t: string) => t.startsWith(LISH_TOPIC_PREFIX))) return false;
		// A shared joined topic is the real authorization — no time limit on it.
		if (this.sharesJoinedTopicWith(peerID)) return true;
		// Infrastructure peers (active relay / bootstrap) are kept connected across a
		// leave without being redial-suppressed, so they never get the soft path — a
		// relay of a network we just left would otherwise browse our shares.
		if (this.isBootstrapOrRelayPeer(peerID)) return false;
		return this.connectionAgeMs(peerID) <= SUBSCRIBE_PROPAGATION_GRACE_MS;
	}

	/**
	 * Age of the longest-lived open connection to a peer, in ms; Infinity when we
	 * have none. The OLDEST connection wins deliberately: a peer that reconnects
	 * while an earlier connection is still open must not buy itself a fresh grace
	 * window, which would reopen the hole the window exists to close.
	 */
	private connectionAgeMs(peerID: string): number {
		if (!this.node) return Infinity;
		let age = Infinity;
		try {
			const now = Date.now();
			for (const c of this.node.getConnections()) {
				if (c.remotePeer.toString() !== peerID) continue;
				const opened = c.timeline?.open;
				// A connection with no open timestamp is not evidence of freshness.
				const candidate = typeof opened === 'number' ? now - opened : Infinity;
				if (age === Infinity || candidate > age) age = candidate;
			}
		} catch {
			return Infinity;
		}
		return age;
	}

	/**
	 * Gracefully disconnect from a single peer and stop libp2p from immediately
	 * re-dialing it. This is the ONLY place that should call `node.hangUp()` so
	 * the accompanying ReconnectQueue cleanup (removing the `keep-alive-fleet`
	 * tag) is never forgotten — without dropping that tag, `peer:discovery` /
	 * ReconnectQueue would re-dial the peer within seconds and the disconnect
	 * would be pointless.
	 *
	 * Also forgets the peerStore entry (via {@link purgeStalePeer}): in-memory redial
	 * suppression is lost on restart, but the persisted peerStore is not, so a leave
	 * followed by a restart before rejoin would otherwise let redial maintenance dial
	 * the left peer straight back. Rejoin re-acquires the entry via bootstrap/discovery.
	 * Best-effort: failures are logged at trace, never thrown.
	 *
	 * Whether the peer may be torn down at all is decided HERE, and re-decided before every
	 * destructive step. It used to rest on the caller's promise that it only passes peers no
	 * joined lishnet wants, and that promise stopped holding once lishnets could join and
	 * leave concurrently: `leaveNetwork` takes its snapshot once and then works through the
	 * peers one await at a time, so a lishnet joined half-way through was invisible to it.
	 * The claim it missed can also arrive from the other side entirely — a remote SUBSCRIBE
	 * on a topic we are in makes the peer a member of it with nothing of ours involved, which
	 * is why a lock over our own operations could not settle this and a fresh check before
	 * each step can. A claim that appears mid-sequence undoes what has been done so far, and
	 * one that appears after the purge at least lifts the suppression again, so maintenance
	 * is free to dial the peer back.
	 *
	 * `networkID` is the lishnet the peer is being left with — the peer is suppressed
	 * under it so rejoining that lishnet lifts exactly its peers.
	 *
	 * `epoch` binds THIS CALL to the node instance it started on, for the same reason
	 * {@link purgeStalePeer} takes one: this awaits twice, and re-reading `this.node` after a
	 * stop()/start() used to hand back the NEW node — so the hangUp and the purge landed on
	 * an instance that had never heard of this leave. It binds one call for one peer and
	 * nothing more: a caller walking several peers has to capture {@link getRunEpoch} once
	 * and pass it in, or the default re-reads the counter per peer and the later peers of a
	 * leave that outlived a restart are torn off the node that replaced it.
	 *
	 * Cancelling either await is safe to do MID-CALL, which is the property that makes binding
	 * them to a signal sound at all. `peerStore.merge` gates only its per-peer write lock and
	 * its read of the existing record on the signal; the write itself is one whole-record
	 * `datastore.put` that the peer store never passes options to, so an aborted merge has
	 * either written the complete new record or written nothing — never half of one. And
	 * `hangUp` funnels into `closeConnections`, which catches the abort and calls
	 * `connection.abort()`, so a cancelled hangUp force-closes the connection rather than
	 * leaving a half-open one for a later path to read as live.
	 *
	 * Every step is bound to this run's cancellation as well — see {@link cancelRunOperations}.
	 * A shutdown waits for the leave that is running, and the peer teardown a leave is made of
	 * has no deadline of its own: one `hangUp` on a peer that never acknowledges held the whole
	 * stop, and the catalog with it, for as long as that peer felt like it. Cancelled, the
	 * remaining peers are given up on. The cost is real but small: their peerStore records and
	 * keep-alive tags outlive the run, so libp2p may redial them after a restart. Nothing here
	 * comes back to tidy that up — they are ordinary non-configured peers, so eviction and the
	 * next leave of that lishnet are what eventually reach them. The alternative is a shutdown
	 * that never returns at all.
	 */
	async disconnectPeer(peerID: string, networkID: string, epoch: number = this.runEpoch): Promise<void> {
		const node = this.node;
		if (!node || epoch !== this.runEpoch) return;
		// Captured beside the node and for the same reason: a controller a later start
		// installed does not speak for the run this call belongs to.
		const signal = this.dialAbort.signal;
		if (signal.aborted) return;
		let pid: PeerID;
		try {
			pid = peerIDFromString(peerID);
		} catch (err: any) {
			trace(`[NET] disconnectPeer: invalid peerID ${peerID.slice(0, 16)}: ${err?.message ?? err}`);
			return;
		}
		if (this.isPeerNeededByJoinedNetwork(peerID)) {
			trace(`[NET] disconnectPeer: ${peerID.slice(0, 16)} is still claimed by a joined lishnet, leaving it alone`);
			return;
		}
		// Suppression is claimed BEFORE the first await, not after the hangUp. The two
		// awaits below yield, and a `peer:discovery` event landing in that window used to
		// read "not suppressed", start a dial, and have it complete after the hangUp had
		// already searched for connections and found none — leaving the peer connected
		// with the leave apparently finished. Recording the intent up front makes the
		// window harmless: the dial that lands late sees the suppression and closes itself.
		this.addRedialSuppression(networkID, peerID);
		// Remove the keep-alive tags FIRST so the imminent hangUp does not race
		// the ReconnectQueue back into a re-dial. Both tags matter: the custom
		// 'keep-alive-fleet' tag (peer-announce intake) and the native KEEP_ALIVE
		// tag (stamped by addBootstrapPeers on every successfully dialed entry,
		// including discovered ones) — libp2p itself re-dials any peer carrying a
		// keep-alive tag, which would silently undo this disconnect. Passing
		// undefined as the tag value removes it (per @libp2p/interface PeerStore
		// merge semantics).
		try {
			await node.peerStore.merge(pid, { tags: { 'keep-alive-fleet': undefined, [KEEP_ALIVE]: undefined } }, { signal });
		} catch (err: any) {
			trace(`[NET] disconnectPeer: tag removal failed for ${peerID.slice(0, 16)}: ${err?.message ?? err}`);
		}
		if (epoch !== this.runEpoch) return;
		if (await this.releaseIfClaimed(node, pid, peerID, networkID, signal)) return;
		// The recheck itself awaits, so the run can end inside it — and a `false` from it is
		// permission to go on tearing down, which must not be spent on the next node instance.
		if (epoch !== this.runEpoch) return;
		try {
			await node.hangUp(pid, { signal });
			trace(`[NET] disconnectPeer: hung up ${peerID.slice(0, 16)}`);
		} catch (err: any) {
			trace(`[NET] disconnectPeer: hangUp failed for ${peerID.slice(0, 16)}: ${err?.message ?? err}`);
		}
		if (epoch !== this.runEpoch) return;
		if (await this.releaseIfClaimed(node, pid, peerID, networkID, signal)) return;
		if (epoch !== this.runEpoch || signal.aborted) return;
		// Forget the persisted peerStore entry so the disconnect survives a restart —
		// suppression is in-memory only, but the peerStore is on disk.
		await this.purgeStalePeer(peerID, 'left-network exclusive peer', epoch);
		// A claim can still land during the purge, and by then the record is gone. What must
		// not survive is the suppression: it is global, so leaving it in place would make
		// every maintenance path refuse to dial a peer a joined lishnet is now asking for.
		if (epoch === this.runEpoch) await this.releaseIfClaimed(node, pid, peerID, networkID, signal);
	}

	/**
	 * Give a peer back if a joined lishnet has claimed it since the disconnect began.
	 *
	 * Undoes this disconnect's own two global effects: the redial suppression entry it added
	 * (only its own — another lishnet's leave is not this one's to reverse) and the keep-alive
	 * tag it removed. `keep-alive-fleet` is deliberately not re-synthesised: peer-announce
	 * intake owns that tag and re-adds it on the next announce, and inventing it here would
	 * claim a fleet membership nothing has observed.
	 *
	 * The claim has to hold on BOTH sides of the restore, and that is the mirror image of the
	 * race this whole recheck exists for. Checking only before the await let the LAST owner
	 * leave while the restore was in flight: the merge then landed after that leave's own
	 * cleanup had finished, putting the keep-alive tag back on a peer nobody wants, and the
	 * `true` returned here told the caller to leave the rest of its teardown undone. Instead
	 * of a shared peer being destroyed, a dead one survived. If the claim is gone by then the
	 * restore is taken back — tag and suppression both — and the caller carries on.
	 *
	 * Taking it back has a window of its own: a THIRD owner can claim the peer while the
	 * re-removal is in flight, and then the tag is stripped from a peer that is wanted again.
	 * That one is self-healing rather than guarded, deliberately — the caller's next call here
	 * (before the purge, and again after it) finds the claim and restores the tag. Guarding it
	 * instead would need a fourth check with a window of its own, and so on; the recheck loop
	 * has to terminate somewhere, and a keep-alive tag missing for the length of one hangUp is
	 * a redial hint lost, not a connection dropped.
	 *
	 * Returns whether the disconnect should stop.
	 */
	private async releaseIfClaimed(node: Libp2p, pid: PeerID, peerID: string, networkID: string, signal: AbortSignal): Promise<boolean> {
		if (!this.isPeerNeededByJoinedNetwork(peerID)) return false;
		this.redialSuppressedByNet.get(networkID)?.delete(peerID);
		try {
			await node.peerStore.merge(pid, { tags: { [KEEP_ALIVE]: { value: 1 } } }, { signal });
		} catch (err: any) {
			trace(`[NET] disconnectPeer: keep-alive restore failed for ${peerID.slice(0, 16)}: ${err?.message ?? err}`);
		}
		if (!this.isPeerNeededByJoinedNetwork(peerID)) {
			this.addRedialSuppression(networkID, peerID);
			try {
				await node.peerStore.merge(pid, { tags: { [KEEP_ALIVE]: undefined } }, { signal });
			} catch (err: any) {
				trace(`[NET] disconnectPeer: keep-alive re-removal failed for ${peerID.slice(0, 16)}: ${err?.message ?? err}`);
			}
			trace(`[NET] disconnectPeer: the claim on ${peerID.slice(0, 16)} was gone again by the restore, continuing the disconnect`);
			return false;
		}
		trace(`[NET] disconnectPeer: ${peerID.slice(0, 16)} was claimed by a joined lishnet mid-disconnect, released`);
		return true;
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
		this.bumpBootstrapGeneration(networkID);
		this.bootstrapTracker.pruneEntries(networkID, keepMultiaddrs);
	}

	/** Reset the bootstrap status for a single network (used when re-joining). */
	resetBootstrapStatus(networkID: string): void {
		this.bumpBootstrapGeneration(networkID);
		this.bootstrapTracker.resetNetwork(networkID);
	}

	/**
	 * Current bootstrap-config version of a network. Entries with no network (the
	 * startup catalog dial) share version 0 and are only bound by the run epoch.
	 */
	private bootstrapGenerationOf(networkID: string | null): number {
		return networkID === null ? 0 : (this.bootstrapGeneration.get(networkID) ?? 0);
	}

	/**
	 * Declare a network's configured bootstrap list superseded, abandoning any
	 * `addBootstrapPeers` job still walking the previous one. Called whenever that
	 * list is replaced, reset or left — see the generation comment in
	 * {@link addBootstrapPeers} for what an unabandoned job would resurrect.
	 */
	bumpBootstrapGeneration(networkID: string): void {
		this.bootstrapGeneration.set(networkID, this.bootstrapGenerationOf(networkID) + 1);
	}

	// =========================================================================
	// Topic (lishnet) management
	// =========================================================================

	/**
	 * Subscribe to a lishnet topic. The node will receive pubsub messages for this network.
	 *
	 * Returns whether the subscription actually happened. Reporting nothing let the caller
	 * record a network as joined after a no-op on a stopped node: `joinedNetworks` claiming
	 * membership of a topic nobody is subscribed to, which a later rejoin then treated as
	 * "already joined" and skipped.
	 */
	subscribeTopic(networkID: string): boolean {
		if (!this.pubsub) {
			console.error('Network not started - cannot subscribe to topic');
			return false;
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
		for (const delay of [2000, 5000, 15000]) this.armDelayedPeerCountCheck(delay);
		return true;
	}

	/**
	 * Unsubscribe from a lishnet topic.
	 */
	unsubscribeHandler(topic: string, handler: TopicHandler): void {
		const handlers = this.topicHandlers.get(topic);
		if (handlers) handlers.delete(handler);
	}

	/**
	 * Whether this node is still subscribed to a lishnet's topic, i.e. has not left it.
	 *
	 * Without pubsub there is no answer to give, and the caller uses this to decide
	 * whether to tear a connection down — so the unknown case reports "still joined",
	 * which is the harmless one.
	 */
	isTopicSubscribed(networkID: string): boolean {
		if (!this.pubsub) return true;
		return this.pubsub.getTopics().includes(lishTopic(networkID));
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

	private handleMessage(msgEvent: PubsubEvent): void {
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
			if (handlers) for (const handler of handlers) handler(message, from);
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
		await Network.publishOn(this.pubsub, topic, data);
	}

	/**
	 * Publish over a SPECIFIC pubsub instance rather than whatever `this.pubsub` is now.
	 *
	 * A long-running emitter captures the pubsub of the run it started in and then awaits
	 * — repeatedly, once per topic. Routing those later publishes through
	 * {@link broadcast} re-reads the field, so a stop/start landing in one of the awaits
	 * put the OLD run's payload (its identity, its addresses, its peerStore snapshot) onto
	 * the NEW node's topics. Binding the publish to the captured transport makes that
	 * impossible instead of merely unlikely.
	 */
	static async publishOn(pubsub: any, topic: string, data: Record<string, any>): Promise<void> {
		trace(`[NET] broadcast ${topic}: ${data['type']}`);
		const encoded = new TextEncoder().encode(JSON.stringify(data));
		const result = await pubsub.publish(topic, encoded);
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
	 * Run a destructive identity/datastore operation with the run provably over.
	 *
	 * `if (this.node) throw` was not that check. For the whole first half of
	 * {@link startLocked} the datastore file is already open and the identity already
	 * read while `this.node` is still null, so the guard passed and the wipe landed
	 * underneath an in-progress start — a deleted peerstore mid-open, or an identity
	 * overwritten after it was read but before the node existed. Holding the same
	 * lifecycle mutex and demanding `stopped` inside it covers every await of a start.
	 */
	private async runWhenStopped<T>(what: string, op: () => Promise<T>): Promise<T> {
		return await this.lifecycleMutex.runExclusive(async () => {
			if (this.lifecycle !== 'stopped') throw new CodedError(ErrorCodes.INTERNAL_ERROR, `Network must be stopped before ${what}`);
			return await op();
		});
	}

	/**
	 * Write a new identity private key into the datastore. The network must be stopped.
	 * Validates the protobuf bytes by attempting to decode them.
	 */
	async writeIdentityKey(privateKeyBytes: Uint8Array): Promise<void> {
		await this.runWhenStopped('writing identity key', () => writeIdentityKeyToDatastore(this.dataDir, privateKeyBytes));
	}

	/**
	 * Delete the identity private key from the datastore. The network must be stopped.
	 * Next start will generate a fresh key.
	 */
	async clearIdentityKey(): Promise<void> {
		await this.runWhenStopped('clearing identity key', () => clearIdentityKeyFromDatastore(this.dataDir));
	}

	/**
	 * Wipe the entire datastore — peerstore (discovered peers, addresses) and the
	 * identity private key. The network must be stopped. Next start regenerates a
	 * fresh identity and an empty peerstore. Used by the factory reset.
	 */
	async clearDatastore(): Promise<void> {
		await this.runWhenStopped('clearing datastore', () => clearDatastoreDir(this.dataDir));
	}

	/**
	 * Wipe only the peerstore entries, preserving the identity private key.
	 * The network must be stopped. After restart the node keeps its peer ID
	 * but discovers peers fresh. Used by the factory reset "peers" category.
	 */
	async clearPeerstore(): Promise<void> {
		await this.runWhenStopped('clearing peerstore', () => clearPeerstoreOnly(this.dataDir));
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
		// Same mutex as start(): a stop that overlapped a start used to tear down a node
		// the start had just handed back to its caller as successfully started.
		await this.lifecycleMutex.runExclusive(async () => {
			// An interrupted libp2p stop cannot be resumed, so a retry would do nothing and
			// report success — the exact no-op that let a half-stopped node be treated as
			// down. Refusing is the honest answer; the process has to be restarted.
			if (this.nodeStopUnrecoverable) throw new CodedError(ErrorCodes.INTERNAL_ERROR, 'Network is in a terminal failed state: its libp2p node could not be stopped and cannot be stopped again — restart the process');
			this.lifecycle = 'stopping';
			try {
				await this.teardown();
				this.lifecycle = 'stopped';
			} catch (err) {
				// teardown kept whatever it could not prove released. Setting `stopped` here
				// regardless is what let the caller go on to start a second node over the same
				// identity, port and datastore, and let a factory reset wipe a datastore still
				// in use. A retry of stop() repeats only the phases that are still outstanding.
				this.lifecycle = 'failed';
				throw err;
			}
		});
	}

	/**
	 * Release everything a run owns. Shared by {@link stop} and by the failure path of
	 * {@link start}, because a half-built start holds the same resources a finished one
	 * does — and leaving them behind is what made a failed start unrecoverable.
	 *
	 * The per-run bookkeeping below is cleared unconditionally, but each owned resource is
	 * released only once it is provably gone: the node, the pubsub handle and the identity
	 * after libp2p has reached `stopped`, the datastore after its own close returned. A stop
	 * that could not prove the node down has not shown it to be down, and everything that
	 * follows — closing its datastore, dropping the reference, permitting a new start or a
	 * wipe — is only safe once it has. That failure propagates and leaves the instance in
	 * `failed`; because libp2p cannot resume an interrupted stop, that particular `failed`
	 * is permanent and {@link stop} refuses to pretend otherwise.
	 */
	private async teardown(): Promise<void> {
		this.runEpoch++; // invalidate any in-flight status tick before touching state
		if (this.statusInterval) {
			clearInterval(this.statusInterval);
			this.statusInterval = null;
		}
		// The epoch bump makes an in-flight tick bail out, but its `finally` runs
		// asynchronously — a fast restart would otherwise find the flag still set and
		// skip its own first tick. The tick only clears the flag for its own epoch, so
		// clearing it here cannot be undone by the outgoing run.
		this.statusTickInFlight = false;
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
		this.bootstrapGeneration.clear();
		// Claims belong to the node being torn down; a dial still settling on the old node
		// must not lock the address out for the next one — nor, by releasing into a shared
		// Set, steal the claim the next one has taken. A new object does both.
		this.inFlightBootstrapDials = new Set<string>();
		this.inFlightDiscoveryDials = new Set<string>();
		this._lastPeerCounts.clear();
		this._lastScores.clear();
		this.redialBackoff.clear();
		this.unreachableQuarantine.clear();
		this.addressProbeBackoff.clear();
		this.configuredBootstrapPeerIDs.clear();
		this.configuredBootstrapAddresses.clear();
		// Per-run like the rest of this state: a fresh node must not inherit a count that
		// makes its very first tick the slow-cadence one.
		this.statusTickCount = 0;
		for (const timer of this.delayedPeerCountTimers) clearTimeout(timer);
		this.delayedPeerCountTimers.clear();
		this.redialSuppressedByNet.clear();
		this.pxIngressLogKeys.clear();
		try {
			if (this.node) {
				await this.node.stop();
				// A resolved stop() is NOT proof the node is down. libp2p sets `status` to
				// 'stopping' before its own stop phases and to 'stopped' only after all of them
				// returned; a phase that throws leaves the status at 'stopping' permanently, and
				// every later stop() call sees a status that is not 'started' and returns at once
				// without doing any more work. Taking that silent no-op for success is what let a
				// node still holding its listener, its connections and its port be reported down.
				if (this.node.status !== 'stopped') throw new CodedError(ErrorCodes.INTERNAL_ERROR, `libp2p did not reach 'stopped' (status: ${this.node.status}) and cannot resume an interrupted stop`);
				console.log('Network stopped');
			}
		} catch (err: any) {
			trace(`[NET] node.stop() failed: ${err?.message ?? err}`);
			// A node that refused to stop may still hold its listener, its connection
			// manager and its port. Closing the datastore it is working over, and dropping
			// the last reference to it, made the damage permanent AND invisible: nobody
			// could see the shutdown had not happened, and the caller was free to start a
			// second node over the same identity, port and datastore. Keep both.
			this.nodeStopUnrecoverable = true;
			throw err;
		}
		// Released only now, with the node provably down: everything below and everything a
		// later start or wipe may do is safe only once it is.
		this.node = null;
		this.pubsub = null;
		this.currentPrivateKey = null;
		try {
			if (this.datastore) {
				await this.datastore.close();
				console.log('Datastore closed');
			}
		} catch (err: any) {
			trace(`[NET] datastore.close() failed: ${err?.message ?? err}`);
			// SqliteDatastore.close() closes the database handle directly and can throw.
			// Swallowing that and reporting a clean stop lost the reference to a database
			// still open: the close could never be retried, a new start would open a second
			// handle on the same file, and clearDatastore / clearPeerstore / an identity
			// change were all permitted over it. The node above is provably down and stays
			// released, so a retried stop() repeats only this close.
			throw err;
		}
		this.datastore = null;
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
}

// Re-exported so callers and tests that already reach for this here keep working; the
// implementation lives in multiaddr-utils so network-config can share it without
// importing this module.
export { extractDestinationPeerID };

/**
 * Normalize a multiaddr STRING for equality comparison.
 *
 * Delegates to {@link canonicalMultiaddr}, which parses the address first — that is
 * what folds an expanded IPv6 literal into its compressed form. Doing it with a regex
 * over the raw text, as this used to, left `/ip6/2001:0db8:0000:...:0001` and
 * `/ip6/2001:db8::1` looking like two different addresses even though they are one,
 * so a configuration edit could leave the old spelling behind in the autodial list.
 */
export function normalizeMultiaddrForCompare(s: string): string {
	return canonicalMultiaddr(s);
}

/**
 * Whether two multiaddrs denote the same transport endpoint, ignoring a trailing
 * `/p2p/<id>` (a dial target usually carries it, `Connection.remoteAddr` may not).
 *
 * Compares the WHOLE remaining address, never a prefix: `/ip4/x/tcp/80` is a string
 * prefix of `/ip4/x/tcp/8080`, so prefix matching would accept a connection on one
 * port as proof for another — exactly the unverified-address case this is used to
 * reject.
 */
export function isSameDialEndpoint(a: string, b: string): boolean {
	const strip = (s: string): string => normalizeMultiaddrForCompare(s).replace(/\/p2p\/[^/]+$/, '');
	const left = strip(a);
	return left.length > 0 && left === strip(b);
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
