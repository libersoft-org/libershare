/** Relay hops, excluding the final destination identity. */
export function relayPeerIDs(address: string): string[] {
	return [...address.matchAll(/\/p2p\/([^/]+)\/p2p-circuit(?=\/|$)/g)].map(match => match[1]!);
}
