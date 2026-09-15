/**
 * Multiaddr helpers shared by the runtime network layer and the libp2p config
 * builder.
 *
 * They live in their own module because `network-config.ts` runs before, and is
 * imported by, `network.ts` — pulling the whole network module in just to reach a
 * two-line helper would make that cycle. Everything here is pure.
 */

import { multiaddr as Multiaddr } from '@multiformats/multiaddr';

/** Multiaddr component code of a `/p2p/<peer-id>` segment. */
export const MULTIADDR_P2P_CODE = 421;

/**
 * Peer ID we would actually connect to when dialing a multiaddr, or null when the
 * address carries no `/p2p` component.
 *
 * A relayed address (`.../p2p/<relay>/p2p-circuit/p2p/<target>`) carries two `/p2p`
 * components; the destination — the peer whose identity the Noise handshake verifies
 * — is the LAST one. Taking the first returns the relay instead, which then gets
 * protected, tagged or suppressed in place of the peer actually meant.
 */
export function extractDestinationPeerID(ma: any): string | null {
	try {
		const components = ma.getComponents().filter((c: { code: number }) => c.code === MULTIADDR_P2P_CODE);
		return components.length > 0 ? (components[components.length - 1].value ?? null) : null;
	} catch {
		return null;
	}
}

/** Same as {@link extractDestinationPeerID} but taking the address as a string. */
export function destinationPeerIDOf(address: string): string | null {
	try {
		return extractDestinationPeerID(Multiaddr(address.trim()));
	} catch {
		return null;
	}
}

/**
 * Bounded memo for the canonical form. Canonicalising parses the address, and callers
 * compare one address against the whole bootstrap list, so the same handful of strings
 * would be re-parsed constantly. The cap stops a flood of gossip-invented addresses
 * from turning the cache into a leak — it is only a cache, so clearing it wholesale
 * costs a recompute and nothing else.
 */
const CANONICAL_CACHE_LIMIT = 4096;
const canonicalCache = new Map<string, string>();

/**
 * One spelling per address, for comparing two multiaddrs that mean the same thing.
 *
 * The string goes through the multiaddr parser first, which is what collapses an
 * expanded IPv6 literal to its compressed form and settles component ordering — a regex
 * over the raw text cannot do that, so two spellings of one address would count as two
 * different entries. Only then is the DNS host folded: DNS is case-insensitive and may
 * carry the FQDN root dot, while a base58 peer ID in the same string is
 * case-SIGNIFICANT and must survive untouched.
 *
 * An unparseable input comes back trimmed rather than throwing: callers use this for
 * equality between values they already hold, and "compares equal only to itself" is the
 * safe answer there.
 */
export function canonicalMultiaddr(address: string): string {
	const cached = canonicalCache.get(address);
	if (cached !== undefined) return cached;
	const result = computeCanonicalMultiaddr(address);
	if (canonicalCache.size >= CANONICAL_CACHE_LIMIT) canonicalCache.clear();
	canonicalCache.set(address, result);
	return result;
}

/** Uncached canonicalisation — see {@link canonicalMultiaddr}. */
function computeCanonicalMultiaddr(address: string): string {
	const trimmed = address.trim();
	let parsed = trimmed;
	try {
		parsed = Multiaddr(trimmed).toString();
	} catch {
		// keep the trimmed original
	}
	return parsed.replace(/\/(dns|dns4|dns6|dnsaddr)\/([^/]+)/gi, (_match, protocol: string, host: string) => `/${protocol.toLowerCase()}/${host.toLowerCase().replace(/\.+$/, '')}`);
}
