import { describe, it, expect } from 'bun:test';
import { canonicalMultiaddr, destinationPeerIDOf, extractDestinationPeerID } from '../../../src/protocol/multiaddr-utils.ts';
import { multiaddr } from '@multiformats/multiaddr';

const PEER_A = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
const RELAY = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fp';

/**
 * These helpers decide whether two addresses are "the same one", which downstream
 * decides whether an entry is replaced, kept, or dialed again. Getting either half
 * wrong is invisible until an address quietly lingers in the autodial list.
 */
describe('canonicalMultiaddr', () => {
	/**
	 * The regex-only version this replaced could not do this: the two spellings are one
	 * address, and treating them as two left a replaced bootstrap behind after an edit.
	 */
	it('folds an expanded IPv6 literal to its compressed form', () => {
		const expanded = `/ip6/2001:0db8:0000:0000:0000:0000:0000:0001/tcp/9090/p2p/${PEER_A}`;
		const compressed = `/ip6/2001:db8::1/tcp/9090/p2p/${PEER_A}`;
		expect(canonicalMultiaddr(expanded)).toBe(canonicalMultiaddr(compressed));
	});

	it('folds DNS host case and the FQDN root dot', () => {
		expect(canonicalMultiaddr('/dns4/EXAMPLE.COM./tcp/443')).toBe('/dns4/example.com/tcp/443');
	});

	it('leaves a peer id alone — base58 is case-significant', () => {
		expect(canonicalMultiaddr(`/ip4/203.0.113.9/tcp/9090/p2p/${PEER_A}`)).toContain(PEER_A);
	});

	it('trims surrounding whitespace, which a text field can easily carry in', () => {
		expect(canonicalMultiaddr(`  /ip4/203.0.113.9/tcp/9090/p2p/${PEER_A}  `)).toBe(`/ip4/203.0.113.9/tcp/9090/p2p/${PEER_A}`);
	});

	it('keeps genuinely different addresses different', () => {
		expect(canonicalMultiaddr('/ip4/203.0.113.9/tcp/80')).not.toBe(canonicalMultiaddr('/ip4/203.0.113.9/tcp/8080'));
	});

	it('returns an unparseable value trimmed rather than throwing', () => {
		expect(canonicalMultiaddr('  not-a-multiaddr  ')).toBe('not-a-multiaddr');
	});

	it('is stable when applied twice', () => {
		const once = canonicalMultiaddr(`/ip6/2001:0db8::0001/tcp/9090/p2p/${PEER_A}`);
		expect(canonicalMultiaddr(once)).toBe(once);
	});
});

describe('extractDestinationPeerID', () => {
	it('returns the peer id of a plain address', () => {
		expect(extractDestinationPeerID(multiaddr(`/ip4/203.0.113.9/tcp/9090/p2p/${PEER_A}`))).toBe(PEER_A);
	});

	/**
	 * The whole reason this helper exists: the first /p2p component of a circuit address
	 * is the relay, and protecting or tagging the relay in place of the peer we meant is
	 * how the wrong identity ends up in the bootstrap sets.
	 */
	it('returns the destination of a circuit address, not the relay', () => {
		expect(extractDestinationPeerID(multiaddr(`/ip4/198.51.100.1/tcp/4001/p2p/${RELAY}/p2p-circuit/p2p/${PEER_A}`))).toBe(PEER_A);
	});

	it('returns null when the address carries no peer id', () => {
		expect(extractDestinationPeerID(multiaddr('/ip4/203.0.113.9/tcp/9090'))).toBeNull();
	});

	it('returns null instead of throwing on something that is not a multiaddr', () => {
		expect(extractDestinationPeerID({} as unknown)).toBeNull();
	});
});

describe('destinationPeerIDOf', () => {
	it('accepts the address as a string, whitespace and all', () => {
		expect(destinationPeerIDOf(`  /ip4/203.0.113.9/tcp/9090/p2p/${PEER_A}  `)).toBe(PEER_A);
	});

	it('returns null for an unparseable string', () => {
		expect(destinationPeerIDOf('nonsense')).toBeNull();
	});
});
