import { createLibp2p } from 'libp2p';
import { KEEP_ALIVE } from '@libp2p/interface';
import { SqliteDatastore } from './datastore.ts';
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { type Libp2p } from 'libp2p';
import { type PeerId as PeerID, type PrivateKey, type Stream } from '@libp2p/interface';
import { peerIdFromString as peerIDFromString } from '@libp2p/peer-id';
import { join } from 'path';
import { existsSync } from 'fs';
import { trace } from '../logger.ts';
import { DataServer } from '../lish/data-server.ts';
import { type Settings } from '../settings.ts';
import { LISH_PROTOCOL, LISHClient, handleLISHProtocol, isUploadEnabled } from './lish-protocol.ts';
import { isBusy } from '../api/busy.ts';
import { buildLibp2pConfig } from './network-config.ts';
import { type WantMessage } from './downloader.ts';
import { lishTopic } from './constants.ts';
import { CodedError, ErrorCodes } from '@shared';
import { Circuit } from '@multiformats/multiaddr-matcher';
import { multiaddr as Multiaddr } from '@multiformats/multiaddr';
type PubSub = any; // PubSub type - using any since the exact type isn't exported from @libp2p/interface v3
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
const PRIVATE_KEY_PATH = '/local/privatekey';
const AUTODIAL_WORKAROUND = true;
/** Minimum interval between two `have` responses sent to the same peer for the same LISH. */
const WANT_RESPONSE_COOLDOWN_MS = 60_000;
/** Periodic cleanup of stale entries in lastWantResponseTime (entries older than the cooldown are useless). */
const WANT_RESPONSE_CLEANUP_INTERVAL_MS = 5 * 60_000;
/**
 * Maximum size (bytes) of an incoming pubsub payload we are willing to decode.
 * Our own control messages ride pubsub (WANT — tiny JSON), but older/foreign peers
 * still broadcast HAVE announcements and catalog inventories on the same topic and
 * those can reach tens of KB for nodes with large libraries. A too-small cap silently
 * dropped those messages so peer presence info never reached topic handlers (observed
 * 46167B payloads from <redacted-public-ip>). 256 KiB fits realistic HAVE/catalog frames while
 * still bounding the damage a malicious publisher can do per message.
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
	private readonly dataServer: DataServer;
	private readonly dataDir: string;
	private statusInterval: NodeJS.Timeout | null = null;
	/**
	 * Per-(peer,lish) timestamp of the last `have` response we sent.
	 * Used to rate-limit responses to repeated `want` queries from the same peer for the same LISH:
	 * we respond at most once per WANT_RESPONSE_COOLDOWN_MS. Periodic cleanup removes stale entries.
	 */
	private readonly lastWantResponseTime = new Map<string, number>();
	private wantResponseCleanupInterval: NodeJS.Timeout | null = null;
	private bootstrapPeerIDs: Set<string> = new Set();
	private dcutrPeers: Set<string> = new Set();
	private bootstrapMultiaddrs: any[] = [];

	// Topic handlers: topic -> Set of handler functions
	private topicHandlers: Map<string, Set<TopicHandler>> = new Map();

	// Peer count change callback and debounce
	private _onPeerCountChange: ((counts: { networkID: string; count: number }[]) => void) | null = null;
	private _peerCountDebounceTimer: NodeJS.Timeout | null = null;
	private _lastPeerCounts: Map<string, number> = new Map();

	// Previous gossipsub peer scores — tracked per-peer to detect significant
	// score deltas and log threshold crossings (e.g. entered graylist).
	private _lastScores: Map<string, number> = new Map();
	private readonly pxIngressLogKeys = new Set<string>();

	// Tracked libp2p/pubsub event listeners for clean removal in stop().
	// Each entry captures the exact handler reference so removeEventListener can unhook it.
	private listeners: Array<{ target: EventTarget; event: string; handler: (evt: any) => void }> = [];

	private readonly settings: Settings;

	constructor(dataDir: string, dataServer: DataServer, settings: Settings) {
		this.dataDir = dataDir;

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
	 * Register an event listener on a libp2p/pubsub target and track it so it can be removed in stop().
	 * IMPORTANT: always use this helper instead of calling addEventListener() directly — otherwise
	 * the handler stays attached after stop() and holds a reference to `this` (memory leak).
	 */
	/**
	 * Runtime patch: wrap @chainsafe/libp2p-gossipsub OutboundStream.push() to swallow
	 * the rejected Promise it returns when rawStream.send() throws synchronously. Upstream
	 * sendRpc() does `try { stream.push(rpc) } catch {}` but push() is declared async, so
	 * the synchronous throw becomes a rejected Promise that the try/catch cannot see.
	 *
	 * We cannot import OutboundStream directly (not in package exports, Bun bundler
	 * refuses `/dist/src/stream.js`). Instead we poll streamsOutbound on the pubsub
	 * instance after startup — once any peer registers a stream we grab its prototype
	 * and override .push() for ALL instances (current + future) since they share one
	 * prototype object.
	 */
	private patchGossipsubOutboundPushOnce(): void {
		const pubsub = this.pubsub as any;
		if (!pubsub || pubsub.__libershareOutboundPatched) return;
		const trySetup = () => {
			try {
				const streamsOutbound: Map<any, any> | undefined = pubsub.streamsOutbound;
				if (!streamsOutbound || streamsOutbound.size === 0) return false;
				const sample = streamsOutbound.values().next().value;
				if (!sample) return false;
				const proto = Object.getPrototypeOf(sample);
				if (!proto || typeof proto.push !== 'function' || proto.__libershareOutboundPatched) return true;
				const original = proto.push;
				proto.push = function (this: any, data: any): any {
					let result: any;
					try {
						result = original.call(this, data);
					} catch (e) {
						// Belt & braces — also handle the sync path if upstream ever de-asyncs push()
						return false;
					}
					// Async throw case: attach .catch() so rejection never reaches unhandledRejection.
					// The underlying stream state (closed) is already tracked by gossipsub; losing
					// the write is exactly what the existing try/catch around sendRpc assumed.
					if (result && typeof (result as Promise<unknown>).catch === 'function') {
						(result as Promise<unknown>).catch(() => { /* stream closed mid-write, swallowed */ });
					}
					return result;
				};
				proto.__libershareOutboundPatched = true;
				pubsub.__libershareOutboundPatched = true;
				console.log('[NET] gossipsub OutboundStream.push() wrapped (sync-throw-in-async bug mitigation)');
				return true;
			} catch (err: any) {
				trace(`[NET] patchGossipsub retry: ${err?.message ?? err}`);
				return false;
			}
		};
		// Try immediately, then poll every 2s for up to 60s (streams appear as peers connect)
		if (trySetup()) return;
		const start = Date.now();
		const interval = setInterval(() => {
			if (trySetup() || Date.now() - start > 60_000) clearInterval(interval);
		}, 2000);
	}

	/**
	 * Strip PX peer lists from incoming PRUNE control messages unless the sender is
	 * explicitly trusted by local operator policy. Normal PRUNE/backoff semantics stay intact.
	 */
	private patchGossipsubPXIngressPolicyOnce(): void {
		const pubsub = this.pubsub as any;
		if (!pubsub || pubsub.__libersharePXIngressPatched) return;
		if (typeof pubsub.handleReceivedRpc !== 'function') {
			throw new Error('PX ingress filter unavailable: gossipsub handleReceivedRpc missing');
		}

		const original = pubsub.handleReceivedRpc.bind(pubsub);
		pubsub.handleReceivedRpc = async (from: any, rpc: any): Promise<any> => {
			const peerExchange = this.settings.list().network.peerExchange;
			if (!peerExchange?.ingressFilterEnabled || !rpc?.control?.prune?.length) return original(from, rpc);

			const sender = from?.toString?.() ?? '';
			const trustedPeerIds = Array.isArray(peerExchange.trustedPeerIds) ? peerExchange.trustedPeerIds : [];
			const trusted = new Set(trustedPeerIds.filter((p): p is string => typeof p === 'string').map(p => p.trim()).filter(Boolean));
			let allowed = 0;
			let stripped = 0;

			const prune = rpc.control.prune.map((p: any) => {
				if (!p?.peers?.length) return p;
				const topic = p.topicID;
				const allowPX = peerExchange.enabled === true && trusted.has(sender) && typeof topic === 'string' && topic.startsWith('lish/');
				if (allowPX) {
					allowed++;
					return p;
				}
				stripped++;
				return { ...p, peers: [] };
			});

			if (stripped > 0 || allowed > 0) {
				const topic = prune.find((p: any) => p?.topicID)?.topicID ?? 'unknown';
				const key = `${allowed > 0 ? 'allow' : 'strip'}:${sender}:${topic}`;
				if (!this.pxIngressLogKeys.has(key)) {
					this.pxIngressLogKeys.add(key);
					if (allowed > 0) console.debug(`[NET] PX ingress allowed sender=${sender.slice(0, 16)} topic=${String(topic).slice(0, 48)} prunes=${allowed}`);
					else console.debug(`[NET] PX ingress stripped sender=${sender.slice(0, 16)} topic=${String(topic).slice(0, 48)} prunes=${stripped}`);
				}
			}

			return original(from, { ...rpc, control: { ...rpc.control, prune } });
		};
		pubsub.__libersharePXIngressPatched = true;
		console.log('[NET] gossipsub PX ingress filter enabled');
	}

	private addListener(target: EventTarget, event: string, handler: (evt: any) => void): void {
		target.addEventListener(event, handler as any);
		this.listeners.push({ target, event, handler });
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
		this.patchGossipsubOutboundPushOnce();
		if (allSettings.network.peerExchange.ingressFilterEnabled === true) this.patchGossipsubPXIngressPolicyOnce();

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
					const connType = remotePeerID ? this.classifyConnection(remotePeerID, isRelay) : 'DIRECT';
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
			this.schedulePeerCountCheck();
		});

		this.addListener(this.pubsub, 'gossipsub:prune', (evt: any) => {
			trace(`[NET] PRUNE: ${evt.detail.peerID} left ${evt.detail.topic}`);
			this.schedulePeerCountCheck();
		});

		console.log('Peers in store:', this.node.getPeers().length);
		console.log('Services loaded:', Object.keys(this.node.services));

		this.setupEventListeners();
		this.setupPubsubDispatch();
		this.setupBootstrapWorkaround();
		this.setupStatusInterval();
		this.setupWantResponseCleanup();
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
			console.debug(`❌ Peer disconnected: ${peerID.slice(0, 16)}, remaining: ${this.node!.getPeers().length}`);
			// Fix C: clear per-peer state on disconnect to prevent unbounded growth
			this.dcutrPeers.delete(peerID);
			this.schedulePeerCountCheck();
		});

		this.addListener(this.node!, 'relay:created-reservation', (evt: any) => {
			console.log(`[NET] 🔄 Relay reservation CREATED with: ${evt.detail?.relay?.toString?.() ?? 'unknown'}`);
		});
		this.addListener(this.node!, 'relay:removed', (evt: any) => {
			console.log(`[NET] ⚠️  Relay removed: ${evt.detail?.relay?.toString?.() ?? 'unknown'}`);
		});
		// Surface reservation failures — silent failures are why <redacted-arm-peer>/local/<redacted-test-container> can't
		// be reached by NAT'd siblings (no /p2p-circuit announceable without reservation).
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
			// Detailed connection info per peer
			const peerDetails = connectedPeers.map(p => {
				const conns = this.node!.getConnections(p);
				const types = conns.map(c => {
					const isRelay = Circuit.matches(c.remoteAddr);
					const limited = (c as any).limits != null;
					return `${isRelay ? 'R' : 'D'}${limited ? 'L' : ''}`;
				});
				return `${p.toString().slice(0, 12)}[${types.join(',')}]`;
			});
			const topicInfo = this.pubsub!.getTopics().map((t: string) => {
				const subs = this.pubsub!.getSubscribers(t);
				return `${t.slice(0, 28)}[${subs.length}]`;
			}).join(' ');
			console.debug(`📊 Status: ${connectedPeers.length} connected, ${allPeers.length} in store, topics: ${topicInfo}`);
			console.debug(`   Peers: ${peerDetails.join(' | ') || '(none)'}`);
			// Announced multiaddrs — if /p2p-circuit appears, relay reservation is active
			const myAddrs = this.node!.getMultiaddrs().map(ma => ma.toString());
			const circuit = myAddrs.filter(a => a.includes('/p2p-circuit'));
			console.debug(`   MyAddrs: ${myAddrs.length} total, ${circuit.length} /p2p-circuit${circuit.length > 0 ? ' (' + circuit.slice(0, 2).map(a => a.slice(0, 80)).join(' | ') + ')' : ''}`);
			// Gossipsub peer scoring — dump top/bottom scores + deltas.
			// INFO: summary (top 3 + bottom 3 + threshold crossings).
			// DEBUG (trace): per-peer full breakdown when LIBERSHARE_SCORE_DEBUG=1.
			try {
				const scoreSvc: any = (this.pubsub as any)?.score;
				if (scoreSvc && typeof scoreSvc.score === 'function') {
					const entries: Array<{ id: string; score: number; delta: number }> = [];
					const configuredPXThreshold = this.settings.list().network.peerExchange?.acceptPXThreshold;
					const pxEligibilityThreshold = typeof configuredPXThreshold === 'number' && Number.isFinite(configuredPXThreshold) && configuredPXThreshold > 0 ? configuredPXThreshold : 10;
					for (const p of connectedPeers) {
						const pid = p.toString();
						const s = Number(scoreSvc.score(pid)) || 0;
						const prev = this._lastScores.get(pid);
						const delta = prev === undefined ? 0 : s - prev;
						entries.push({ id: pid, score: s, delta });
						// Threshold-crossing INFO logs
						if (prev !== undefined) {
							if (prev >= -80 && s < -80) console.warn(`[NET] peer ${pid.slice(0, 12)} entered graylist (score=${s.toFixed(1)})`);
							else if (prev < -80 && s >= -80) console.log(`[NET] peer ${pid.slice(0, 12)} left graylist (score=${s.toFixed(1)})`);
							else if (prev < pxEligibilityThreshold && s >= pxEligibilityThreshold) console.log(`[NET] peer ${pid.slice(0, 12)} now PX-eligible (score=${s.toFixed(1)}, threshold=${pxEligibilityThreshold})`);
							else if (prev >= pxEligibilityThreshold && s < pxEligibilityThreshold) console.log(`[NET] peer ${pid.slice(0, 12)} lost PX eligibility (score=${s.toFixed(1)}, threshold=${pxEligibilityThreshold})`);
						}
						this._lastScores.set(pid, s);
					}
					// Evict entries for peers no longer connected
					const connectedSet2 = new Set(connectedPeers.map(p => p.toString()));
					for (const k of this._lastScores.keys()) if (!connectedSet2.has(k)) this._lastScores.delete(k);
					if (entries.length > 0) {
						entries.sort((a, b) => b.score - a.score);
						const fmt = (e: { id: string; score: number; delta: number }) =>
							`${e.id.slice(0, 12)}=${e.score.toFixed(1)}${e.delta !== 0 ? (e.delta > 0 ? '(+' : '(') + e.delta.toFixed(1) + ')' : ''}`;
						const top = entries.slice(0, 3).map(fmt).join(' | ');
						const bot = entries.length > 3 ? entries.slice(-3).reverse().map(fmt).join(' | ') : '';
						console.debug(`   Scores top: ${top}${bot ? ' | bot: ' + bot : ''}`);
					}
					if (process.env['LIBERSHARE_SCORE_DEBUG'] === '1' && entries.length > 0) {
						const fullDump = entries
							.map(e => `${e.id.slice(0, 16)}:${e.score.toFixed(2)}`)
							.join(' ');
						trace(`[NET] full scores: ${fullDump}`);
					}
				}
			} catch (err: any) {
				trace(`[NET] score dump error: ${err?.message ?? err}`);
			}
			// Periodic peer count refresh — catches cases where GRAFT/PRUNE events were missed
			this.checkPeerCounts();
			// Dial known peers not currently connected (maintains relay connections to NATed peers)
			const connectedSet = new Set(connectedPeers.map(p => p.toString()));
			let redialAttempts = 0;
			let redialSuccess = 0;
			for (const peer of allPeers) {
				const pid = peer.id.toString();
				if (connectedSet.has(pid)) continue;
				if (this.bootstrapPeerIDs.has(pid)) continue; // bootstrap handled separately
				redialAttempts++;
				try {
					await this.node!.dial(peer.id, { signal: AbortSignal.timeout(5000) });
					const conns = this.node!.getConnections(peer.id);
					const connType = conns.map(c => (Circuit.matches(c.remoteAddr) ? 'RELAY' : 'DIRECT')).join(',');
					trace(`   ✓ Re-dialed ${pid.slice(0, 16)} [${connType}]`);
					redialSuccess++;
				} catch (err: any) {
					trace(`   ✗ Re-dial ${pid.slice(0, 16)} failed: ${err.message?.slice(0, 80)}`);
				}
			}
			if (redialAttempts > 0) console.debug(`   Re-dial: ${redialSuccess}/${redialAttempts} succeeded`);
			if (AUTODIAL_WORKAROUND && connectedPeers.length === 0 && this.bootstrapMultiaddrs.length > 0) {
				console.log('   ⚠️  No connections - dialing bootstrap peers directly...');
				for (const ma of this.bootstrapMultiaddrs) {
					try {
						await this.node!.dial(ma, { signal: AbortSignal.timeout(10000) });
						console.log(`   ✓ Connected`);
						break;
					} catch (err: any) {
						console.log(`   ✗ Failed: ${err.message}`);
					}
				}
			}
			} catch (err: any) {
				trace(`[NET] statusInterval error: ${err?.message ?? err}`);
			}
		}, 30000);
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
		const myPeerID = this.node.peerId.toString();
		for (const peer of peers) {
			// Skip our own address or already-known bootstrap peers
			if (peer.includes(myPeerID)) continue;
			try {
				const ma = Multiaddr(peer);
				const peerID = ma.getComponents().find(c => c.code === 421)?.value ?? null;
				if (peerID && this.bootstrapPeerIDs.has(peerID)) continue;
				if (peerID) {
					this.bootstrapPeerIDs.add(peerID);
					this.bootstrapMultiaddrs.push(ma);
				}
				console.debug('Adding bootstrap peer:', peer);
				try {
					await this.node.dial(ma);
					if (peerID) {
						await this.node.peerStore.merge(peerIDFromString(peerID), {
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
		// Register per-topic score parameters so gossipsub can measure peer behaviour
		// (P1 timeInMesh, P2 firstMessageDeliveries, P4 invalidMessageDeliveries) for
		// this topic. Without this, per-topic score is always 0 → acceptPXThreshold
		// unreachable for non-bootstrap peers → PX limited to bootstrap-sourced peers only.
		// P3 (meshMessageDeliveries) intentionally disabled: false-positive killer in
		// low-traffic topics per Ethereum consensus research.
		const scoreSvc = (this.pubsub as any).score;
		if (scoreSvc?.params?.topics) {
			scoreSvc.params.topics[topic] = {
				topicWeight: 0.5,
				timeInMeshWeight: 0.01,
				timeInMeshQuantum: 1000,
				timeInMeshCap: 300,
				firstMessageDeliveriesWeight: 0.5,
				firstMessageDeliveriesDecay: 0.998,
				firstMessageDeliveriesCap: 100,
				meshMessageDeliveriesWeight: 0,
				meshFailurePenaltyWeight: 0,
				invalidMessageDeliveriesWeight: -20,
				invalidMessageDeliveriesDecay: 0.9,
			};
			console.log(`[NET] gossipsub score registered for ${topic}`);
		} else {
			trace(`[NET] gossipsub score service not available for ${topic}`);
		}
		// Register the Want handler for this network. TopicHandler is sync (returns void) but
		// handleWant is async — a rejection from any async operation inside it (dial failure,
		// CodedError from closed stream, etc.) would otherwise propagate as unhandledRejection.
		// Catch here so the pubsub dispatch loop remains isolated from per-handler failures.
		const handler: TopicHandler = (data, from) => {
			trace(`[NET] pubsub ${topic}: ${data['type']}`);
			if (data['type'] === 'want') {
				this.handleWant(data as WantMessage, networkID, from).catch(err => {
					trace(`[NET] handleWant failed: ${err?.message ?? err}`);
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
	// Want/Have protocol (LISH data exchange)
	// =========================================================================

	private async handleWant(data: WantMessage, networkID: string, fromPeerID?: string): Promise<void> {
		if (!fromPeerID) {
			trace(`[NET] want ignored: no verified sender peerID`);
			return;
		}
		if (!isUploadEnabled(data.lishID)) {
			trace(`[NET] want ignored: upload disabled for ${data.lishID.slice(0, 8)}`);
			return;
		}
		if (isBusy(data.lishID)) {
			trace(`[NET] want ignored: busy for ${data.lishID.slice(0, 8)}`);
			return;
		}
		// Per-(peer,lish) rate-limit: ignore want from same peer for same LISH within cooldown.
		// Without this, an aggressive (or buggy) peer could trigger many redundant HAVE responses.
		const key = `${fromPeerID}:${data.lishID}`;
		const last = this.lastWantResponseTime.get(key);
		if (last !== undefined && Date.now() - last < WANT_RESPONSE_COOLDOWN_MS) {
			trace(`[NET] want rate-limited: ${fromPeerID.slice(0, 12)} for ${data.lishID.slice(0, 8)} (cooldown)`);
			return;
		}
		// Networks, by referenced networkID, are also checked: the seeder must belong to the same LISH net.
		// (networkID currently unused beyond routing; future: verify lish.networkIDs.includes(networkID).)
		void networkID;
		const lish = this.dataServer.get(data.lishID);
		if (!lish) return;
		// Verify data directory exists on disk — prevents false-positive "have"
		// when DB says have=TRUE but files were lost (e.g. Docker rebuild without volume)
		if (!lish.directory || !existsSync(lish.directory)) {
			console.warn(`[NET] want ignored: data directory missing for ${data.lishID.slice(0, 8)} (${lish.directory ?? 'no dir'})`);
			return;
		}
		const haveChunks = this.dataServer.getHaveChunks(data.lishID);
		if (haveChunks !== 'all' && haveChunks.size === 0) {
			trace(`[NET] no chunks for ${data.lishID.slice(0, 8)}`);
			return;
		}
		const myAddrs = this.node!.getMultiaddrs().map(ma => ma.toString());
		const chunksPayload: import('./lish-protocol.ts').HaveChunks = haveChunks === 'all' ? 'all' : Array.from(haveChunks);
		console.debug(`[NET] sending unicast HAVE to ${fromPeerID.slice(0, 12)} for ${data.lishID.slice(0, 8)}, chunks=${chunksPayload === 'all' ? 'ALL' : chunksPayload.length}`);
		// Open a fresh LISH protocol stream to the requester and send the HAVE announcement.
		// Errors are traced (not thrown) — a single unreachable requester mustn't break our own subscription.
		let client: LISHClient | undefined;
		try {
			const { stream } = await this.dialProtocolByPeerId(fromPeerID, LISH_PROTOCOL);
			client = new LISHClient(stream);
			await client.announceHave(data.lishID, chunksPayload, myAddrs);
		} catch (err: any) {
			trace(`[NET] announceHave to ${fromPeerID.slice(0, 12)} failed: ${err?.message ?? err}`);
			await client?.close().catch(() => {});
			return;
		}
		await client.close().catch(() => {});
		// Record send time only after the announcement was sent; cleanup interval drains stale entries.
		this.lastWantResponseTime.set(key, Date.now());
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
		console.debug(`Subscribed to topic: ${topic}`);
	}

	async connectToPeer(multiaddr: string): Promise<void> {
		if (!this.node) throw new CodedError(ErrorCodes.NETWORK_NOT_STARTED);
		const ma = Multiaddr(multiaddr);
		await this.node.dial(ma);
		console.debug('→ Connected to:', multiaddr);
	}

	/**
	 * Determine connection type from a specific connection + dcutrPeers set.
	 * Only dcutr:success event marks a peer as DCUtR — not the presence of both
	 * relay and direct connections (which can happen during normal discovery).
	 */
	private classifyConnection(peerID: string, isRelay: boolean): 'DIRECT' | 'RELAY' | 'DCUtR' {
		const isDcutr = this.dcutrPeers.has(peerID);
		const result = isDcutr && !isRelay ? 'DCUtR' : isRelay ? 'RELAY' : 'DIRECT';
		trace(`[NET] classify ${peerID.slice(0, 12)}: relay=${isRelay} dcutrSet=${isDcutr} → ${result}`);
		return result;
	}

	async dialProtocol(multiaddrs: any[], protocol: string): Promise<{ stream: Stream; connectionType: 'DIRECT' | 'RELAY' | 'DCUtR' }> {
		if (!this.node) throw new CodedError(ErrorCodes.NETWORK_NOT_STARTED);
		trace(`[NET] dial ${protocol} to ${multiaddrs.map(m => m.toString()).join(', ')}`);
		const connection = await this.node.dial(multiaddrs);
		const peerID = connection.remotePeer.toString();
		const isRelay = Circuit.matches(connection.remoteAddr);
		const connectionType = this.classifyConnection(peerID, isRelay);
		const limited = (connection as any).limits != null;
		console.debug(`[NET] dial connected: ${peerID.slice(0, 16)} [${connectionType}${limited ? ',LIMITED' : ''}] addr=${connection.remoteAddr.toString().slice(0, 60)}`);
		const stream = await connection.newStream(protocol, { runOnLimitedConnection: true });
		trace(`[NET] stream opened: id=${stream.id}, status=${stream.status}`);
		return { stream, connectionType };
	}

	async dialProtocolByPeerId(peerID: string, protocol: string): Promise<{ stream: Stream; connectionType: 'DIRECT' | 'RELAY' | 'DCUtR' }> {
		if (!this.node) throw new CodedError(ErrorCodes.NETWORK_NOT_STARTED);
		trace(`[NET] dial ${protocol} to ${peerID.slice(0, 16)}`);
		const { peerIdFromString } = await import('@libp2p/peer-id');
		const pid = peerIdFromString(peerID);
		const connection = await this.node.dial(pid);
		const isRelay = Circuit.matches(connection.remoteAddr);
		const connectionType = this.classifyConnection(peerID, isRelay);
		const limited = (connection as any).limits != null;
		console.debug(`[NET] dial connected: ${peerID.slice(0, 16)} [${connectionType}${limited ? ',LIMITED' : ''}] addr=${connection.remoteAddr.toString().slice(0, 60)}`);
		const stream = await connection.newStream(protocol, { runOnLimitedConnection: true });
		trace(`[NET] stream opened: id=${stream.id}, status=${stream.status}`);
		return { stream, connectionType };
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
		if (this.wantResponseCleanupInterval) {
			clearInterval(this.wantResponseCleanupInterval);
			this.wantResponseCleanupInterval = null;
		}
		this.lastWantResponseTime.clear();
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
		this.bootstrapMultiaddrs = [];
		this._lastPeerCounts.clear();
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
