import { describe, it, expect } from 'bun:test';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { buildLibp2pConfig } from '../../../src/protocol/network-config.ts';

/**
 * A bootstrap entry is "ours" only when the address DESTINATION is our own identity.
 * A relayed entry `/…/p2p/<us>/p2p-circuit/p2p/<remote>` mentions us as the relay hop
 * while targeting somebody else, and a substring test dropped it as self — silently
 * removing a configured peer from the bootstrap list and from gossipsub's direct set.
 */

const REMOTE = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';

async function build(bootstrapPeers: string[], myPeerID: string) {
	const privateKey = await generateKeyPair('Ed25519');
	return buildLibp2pConfig({
		privateKey,
		datastore: {},
		allSettings: { network: { mdnsEnabled: false } } as any,
		bootstrapPeers,
		myPeerID,
	});
}

describe('buildLibp2pConfig — the self filter reads the destination', () => {
	it('keeps a relayed entry that merely passes through our own identity', async () => {
		const me = '12D3KooWMyOwnIdentityAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
		const viaUs = `/ip4/198.51.100.4/tcp/9090/p2p/${me}/p2p-circuit/p2p/${REMOTE}`;

		const { bootstrapPeerIDs } = await build([viaUs], me);

		expect([...bootstrapPeerIDs]).toEqual([REMOTE]);
	});

	it('still drops an entry that really targets us', async () => {
		const me = REMOTE;
		const ours = `/ip4/198.51.100.4/tcp/9090/p2p/${me}`;

		const { bootstrapPeerIDs, bootstrapMultiaddrs } = await build([ours], me);

		expect([...bootstrapPeerIDs]).toEqual([]);
		expect(bootstrapMultiaddrs).toEqual([]);
	});
});
