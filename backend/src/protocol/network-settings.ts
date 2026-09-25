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

/** Whether two projections build the same node. */
export function sameEffectiveNetworkConfig(a: EffectiveNetworkConfig, b: EffectiveNetworkConfig): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
