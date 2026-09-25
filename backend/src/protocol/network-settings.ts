import { type SettingsData } from '../settings.ts';
import { normalizeTrustedPeerIds, parseAcceptPXThreshold } from './constants.ts';

/**
 * The values the libp2p node is actually built from, normalised the one way the builder uses
 * them. Two settings documents that produce the same projection build the same node, so a
 * difference here — and only here — means the running node needs a restart to follow.
 */
export interface EffectiveNetworkConfig {
	readonly incomingPort: number;
	readonly announceAddresses: readonly string[];
	/** Null when mDNS is off: its interval then builds nothing. */
	readonly mdnsInterval: number | null;
	readonly upnp: boolean;
	/** Null when this node serves no relay; 0 means unlimited reservations. */
	readonly relayReservations: number | null;
	/** How many relay reservations this node makes as a client; 0 disables the client role. */
	readonly relayClientSlots: number;
	readonly peerExchange: {
		readonly enabled: boolean;
		readonly acceptPXThreshold: number;
		/** Sorted, so a reordered list is the same list. */
		readonly trustedPeerIds: readonly string[];
		readonly ingressFilterEnabled: boolean;
	};
}

/** Project a `network` settings group onto what the node is built from. */
export function effectiveNetworkConfig(network: Partial<SettingsData['network']> | undefined): EffectiveNetworkConfig {
	const useRelayClients = network?.useRelayClients !== false;
	const rawMaxRelayClients = network?.maxRelayClients;
	const mdnsEnabled = network?.mdnsEnabled ?? true;
	const peerExchange = network?.peerExchange;
	return {
		incomingPort: network?.incomingPort || 0,
		announceAddresses: [...(network?.announceAddresses ?? [])],
		mdnsInterval: mdnsEnabled ? (network?.mdnsInterval ?? 30000) : null,
		upnp: !!network?.upnpEnabled,
		relayReservations: network?.allowRelay ? (network?.maxRelayReservations ?? 0) : null,
		relayClientSlots: useRelayClients ? (typeof rawMaxRelayClients === 'number' && rawMaxRelayClients > 0 ? Math.min(rawMaxRelayClients, 20) : 5) : 0,
		peerExchange: {
			enabled: peerExchange?.enabled === true,
			acceptPXThreshold: parseAcceptPXThreshold(peerExchange?.acceptPXThreshold).value,
			trustedPeerIds: [...normalizeTrustedPeerIds(peerExchange?.trustedPeerIds)].sort(),
			ingressFilterEnabled: peerExchange?.ingressFilterEnabled === true,
		},
	};
}

/**
 * `network.*` settings that touch the P2P node: live transfer limits, values read at their next
 * use, and everything the node is built from. The rest of the group (auto-start switches,
 * search timeout, primary interface) is read by the next action or the UI and needs nothing
 * from the node.
 */
const P2P_SETTING_KEYS = new Set(['maxDownloadSpeed', 'maxUploadSpeed', 'maxDownloadPeersPerLISH', 'maxUploadPeersPerLISH', 'maxChunkSize', 'maxMessageSize', 'incomingPort', 'announceAddresses', 'mdnsEnabled', 'mdnsInterval', 'upnpEnabled', 'allowRelay', 'maxRelayReservations', 'useRelayClients', 'maxRelayClients', 'peerExchange']);

/**
 * Whether a write asked for P2P settings to be applied: one of its accepted paths is the
 * `network` group itself, or reaches one of {@link P2P_SETTING_KEYS} — even when the value did
 * not change, since writing the same port again is still an attempt to use it.
 */
export function requestsP2PApply(paths: readonly string[]): boolean {
	return paths.some(path => {
		const segments = path.split('.');
		if (segments[0] !== 'network') return false;
		return segments.length === 1 || P2P_SETTING_KEYS.has(segments[1]!);
	});
}

/** Whether two projections build the same node. */
export function sameEffectiveNetworkConfig(a: EffectiveNetworkConfig, b: EffectiveNetworkConfig): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
