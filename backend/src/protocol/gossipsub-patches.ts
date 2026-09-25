import { type Settings } from '../settings.ts';
import { normalizeTrustedPeerIds, LISH_TOPIC_PREFIX } from './constants.ts';

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
	if (opts.pxIngressEnabled) applyGossipsubPXIngressPatch(pubsub, deps);
}
