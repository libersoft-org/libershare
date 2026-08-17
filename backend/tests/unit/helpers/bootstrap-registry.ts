import { multiaddr } from '@multiformats/multiaddr';
import { extractDestinationPeerID, normalizeMultiaddrForCompare, type IBootstrapEntry } from '../../../src/protocol/network.ts';

/** One address to seed into a test network's bootstrap registry. */
export interface IRegistrySeed {
	/** Multiaddr string. Stored under its canonical form, as the production path does. */
	address: string;
	/** Network IDs configuring this address. Omit or leave empty for a gossip-discovered entry. */
	configuredBy?: string[];
	/** Epoch ms the entry first entered the registry. Defaults to now. */
	firstSeenAt?: number;
	/** Epoch ms a dial last proved this endpoint. Defaults to never. */
	lastVerifiedAt?: number | null;
	/** Epoch ms the peer behind it last disconnected. Defaults to never. */
	lastDisconnectedAt?: number | null;
}

/**
 * Seed `bootstrapByAddress` / `addressesByPeer` on a `Object.create(Network.prototype)`
 * stub, replacing whatever was there.
 *
 * The two maps have to stay consistent — every code path that removes an address goes
 * through the reverse index — so building them by hand in each test was the obvious way
 * to get a passing test that proves nothing.
 */
export function installBootstrapRegistry(network: unknown, seeds: readonly IRegistrySeed[]): Map<string, IBootstrapEntry> {
	const byAddress = new Map<string, IBootstrapEntry>();
	const byPeer = new Map<string, Set<string>>();
	for (const seed of seeds) {
		const ma = multiaddr(seed.address);
		const key = normalizeMultiaddrForCompare(ma.toString());
		const peerID = extractDestinationPeerID(ma);
		byAddress.set(key, {
			key,
			ma,
			peerID,
			configuredBy: new Set(seed.configuredBy ?? []),
			firstSeenAt: seed.firstSeenAt ?? Date.now(),
			lastVerifiedAt: seed.lastVerifiedAt ?? null,
			lastDisconnectedAt: seed.lastDisconnectedAt ?? null,
		});
		if (peerID) {
			let keys = byPeer.get(peerID);
			if (!keys) {
				keys = new Set<string>();
				byPeer.set(peerID, keys);
			}
			keys.add(key);
		}
	}
	(network as any).bootstrapByAddress = byAddress;
	(network as any).addressesByPeer = byPeer;
	(network as any).recoveryBackoff ??= new Map();
	// Object.create(Network.prototype) never runs field initializers, so the walk state
	// the registry loops read has to be seeded here alongside the registry itself.
	(network as any).recoveryCursors ??= { configured: null, discovered: null };
	(network as any).inFlightBootstrapDials ??= new Set<string>();
	return byAddress;
}

/** Canonical addresses currently in a test network's registry, in insertion order. */
export function registryAddresses(network: unknown): string[] {
	return [...((network as any).bootstrapByAddress as Map<string, IBootstrapEntry>).keys()];
}
