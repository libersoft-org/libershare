import { type Settings } from '../settings.ts';
import { normalizeTrustedPeerIds, LISH_TOPIC_PREFIX } from './constants.ts';
import { trace } from '../logger.ts';

/**
 * Dependencies consumed by gossipsub patch helpers.
 */
export interface GossipsubPatchDeps {
	readonly settings: Settings;
	/**
	 * Returns the peer IDs the operator configured as bootstrap peers. Called at
	 * filter time, not cached.
	 *
	 * Must NOT be the wider autodial set: that one also holds gossip-discovered and
	 * auto-promoted peers, so any topic subscriber could announce itself into PX
	 * trust and then feed us its own PX peer lists.
	 */
	getConfiguredBootstrapPeerIDs(): Set<string>;
	/**
	 * Per-Network-instance set for PX ingress log-key dedup (one-time log per sender+topic+action).
	 * Owned and reset by the caller (Network); passed here to avoid module-global shared state
	 * across multiple Network instances and to allow garbage collection on Network.stop().
	 */
	readonly pxIngressLogKeys: Set<string>;
}

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
 *
 * TODO(upstream): this intentionally reaches into private gossipsub internals
 * (`streamsOutbound` and OutboundStream.prototype). Keep it as a temporary
 * mitigation only; replace it with an upstream @chainsafe/libp2p-gossipsub fix
 * once sendRpc/push handles rejected async writes and evicts dead streams itself.
 */
/**
 * The gossipsub instance the shared-prototype wrapper currently serves.
 *
 * The wrapper is installed on the SHARED OutboundStream prototype, so it outlives
 * the instance that installed it. Capturing that instance in the closure meant that
 * after a node restart every eviction went to the DEAD instance's stream map — a
 * silent no-op that disabled the mitigation — while the closure also pinned the dead
 * instance in memory. Tracking the latest patched instance instead fixes both.
 *
 * ponytail: one live node per process, so "latest wins" is the whole ownership
 * model. If several nodes ever run side by side this needs a per-stream owner map.
 */
let activePubsub: any = null;

/** One warn line per peer per 5 s, module-level so a restart does not reset the window. */
const pushFailLogged = new Map<string, number>();

/**
 * Evict a dead outbound stream from the gossipsub instance that owns it. Returns a
 * short peer-id label for logging, or '' when the stream has no known owner.
 */
function evictFailedStream(failedStream: any): string {
	const gs = activePubsub;
	if (!(gs?.streamsOutbound instanceof Map)) return '';
	for (const [pid, stream] of gs.streamsOutbound) {
		if (stream !== failedStream) continue;
		try {
			stream.close?.().catch?.(() => {});
		} catch {
			/* ignore */
		}
		gs.streamsOutbound.delete(pid);
		return pid.toString().slice(0, 12);
	}
	return '';
}

export function applyGossipsubOutboundPushPatch(pubsub: any): void {
	if (!pubsub) return;
	// Adopt before the idempotency guard: a restart reuses the already-patched
	// prototype and returns early, so this is the only chance to point the wrapper at
	// the new instance.
	activePubsub = pubsub;
	// Idempotency guard: the push() wrap is installed on the shared OutboundStream
	// prototype, so re-running this must be a no-op once the marker is set.
	if (pubsub.__p2pfsOutboundPatched) return;
	const trySetup = (): boolean => {
		try {
			const streamsOutbound: Map<any, any> | undefined = pubsub.streamsOutbound;
			if (!streamsOutbound || streamsOutbound.size === 0) return false;
			const sample = streamsOutbound.values().next().value;
			if (!sample) return false;
			const proto = Object.getPrototypeOf(sample);
			if (!proto || typeof proto.push !== 'function' || proto.__p2pfsOutboundPatched) return true;
			const original = proto.push;
			// Forward all arguments via rest+apply so a future upstream signature
			// extension (e.g. push(data, opts)) is preserved transparently.
			proto.push = function (this: any, ...args: any[]): any {
				let result: any;
				try {
					result = original.apply(this, args);
				} catch (e) {
					// Belt & braces — also handle the sync path if upstream ever de-asyncs push()
					return false;
				}
				// Async throw case: attach .catch() so rejection never reaches unhandledRejection.
				// The underlying stream state (closed) is already tracked by gossipsub; losing
				// the write is exactly what the existing try/catch around sendRpc assumed.
				if (result && typeof (result as Promise<unknown>).catch === 'function') {
					const failedStream = this; // OutboundStream instance
					(result as Promise<unknown>).catch((e: any) => {
						// Reverse lookup across every live instance: find which peerId owns this
						// dead stream and evict it from streamsOutbound so the next sendRpc call
						// sees null and gossipsub reattaches a fresh stream on reconnect.
						const evicted = evictFailedStream(failedStream);
						// Rate-limit so a flapping peer (NAT churn / Wi-Fi roam) cannot fill the log
						// with thousands of identical lines per hour. One warn line per peer per 5 s.
						const now = Date.now();
						const key = evicted || 'unknown';
						if ((pushFailLogged.get(key) ?? 0) + 5000 < now) {
							pushFailLogged.set(key, now);
							console.warn('[GS-PUSH-FAIL] async push rejected to', key, ':', e?.code ?? e?.name ?? '', e?.message ?? String(e), '— evicted stream');
						}
					});
				}
				return result;
			};
			proto.__p2pfsOutboundPatched = true;
			pubsub.__p2pfsOutboundPatched = true;
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
export function applyGossipsubPXIngressPatch(pubsub: any, deps: GossipsubPatchDeps): void {
	// Idempotency guard: handleReceivedRpc is wrapped only once per pubsub instance.
	if (!pubsub || pubsub.__p2pfsPXIngressPatched) return;
	if (typeof pubsub.handleReceivedRpc !== 'function') {
		throw new Error('PX ingress filter unavailable: gossipsub handleReceivedRpc missing');
	}

	const original = pubsub.handleReceivedRpc.bind(pubsub);
	pubsub.handleReceivedRpc = async (from: any, rpc: any): Promise<any> => {
		const peerExchange = deps.settings.list().network.peerExchange;
		if (!peerExchange?.ingressFilterEnabled || !rpc?.control?.prune?.length) return original(from, rpc);

		const sender = from?.toString?.() ?? '';
		// Trust union: explicit operator-configured peers + CONFIGURED bootstrap peers of
		// the lishnets the operator has joined (both represent "operator deliberately
		// chose to trust this peer", see appSpecificScore in network-config.ts).
		const trusted = normalizeTrustedPeerIds(peerExchange.trustedPeerIds);
		for (const bp of deps.getConfiguredBootstrapPeerIDs()) trusted.add(bp);
		let allowed = 0;
		let stripped = 0;

		const prune = rpc.control.prune.map((p: any) => {
			if (!p?.peers?.length) return p;
			const topic = p.topicID;
			const allowPX = peerExchange.enabled === true && trusted.has(sender) && typeof topic === 'string' && topic.startsWith(LISH_TOPIC_PREFIX);
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
			if (!deps.pxIngressLogKeys.has(key)) {
				deps.pxIngressLogKeys.add(key);
				if (allowed > 0) console.debug(`[NET] PX ingress allowed sender=${sender.slice(0, 16)} topic=${String(topic).slice(0, 48)} prunes=${allowed}`);
				else console.debug(`[NET] PX ingress stripped sender=${sender.slice(0, 16)} topic=${String(topic).slice(0, 48)} prunes=${stripped}`);
			}
		}

		return original(from, { ...rpc, control: { ...rpc.control, prune } });
	};
	pubsub.__p2pfsPXIngressPatched = true;
	console.log('[NET] gossipsub PX ingress filter enabled');
}

/**
 * Apply all gossipsub patches in the correct order.
 * Call after pubsub is available (immediately after start()).
 */
export function applyGossipsubPatches(pubsub: any, deps: GossipsubPatchDeps, opts: { pxIngressEnabled: boolean }): void {
	applyGossipsubOutboundPushPatch(pubsub);
	if (opts.pxIngressEnabled) applyGossipsubPXIngressPatch(pubsub, deps);
}
