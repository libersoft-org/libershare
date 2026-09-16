import { describe, it, expect } from 'bun:test';
import { multiaddr } from '@multiformats/multiaddr';
import { buildLibp2pConfig } from '../../../src/protocol/network-config.ts';

/**
 * The configured-bootstrap set is the node's trust boundary: the dial gater bypasses its
 * address filter for it, and the PX appSpecificScore hands it a positive score. Both read
 * the set through a closure created inside {@link buildLibp2pConfig}.
 *
 * `Network` mutates that boundary at runtime — a configured re-add claims a peer, a prune
 * or a superseded dial gives it back — so it has to hold the SAME set the closures read.
 * A copy leaves the two disagreeing: an operator entry removed at runtime keeps its gater
 * bypass for the rest of the process, and one added never gets it.
 *
 * Drives the real config builder and the real gater callback; only the peer identity and
 * the address are fixtures.
 */

const PEER = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
// Loopback: denied from any host unless the peer is trusted, so the gater's answer is
// decided by the trust set alone rather than by whatever interfaces this machine has.
const ADDR = `/ip4/127.0.0.1/tcp/9090/p2p/${PEER}`;

function build() {
	const allSettings: any = {
		network: {
			incomingPort: 0,
			maxRelayReservations: 0,
			allowRelay: false,
			peerExchange: { enabled: false, trustedPeerIds: [], acceptPXThreshold: 5, ingressFilterEnabled: false },
			mdns: false,
			upnp: false,
			autonat: false,
		},
	};
	return buildLibp2pConfig({
		privateKey: { publicKey: { toString: (): string => 'self' } } as any,
		datastore: {} as any,
		allSettings,
		bootstrapPeers: [],
		myPeerID: 'self',
	});
}

const denyDial = (config: any, address: string): Promise<boolean> => config.connectionGater.denyDialMultiaddr(multiaddr(address));

describe('configured bootstrap set — one set, not a copy', () => {
	it('lets a peer added after the config was built through the dial gater', async () => {
		const { config, configuredBootstrapPeerIDs } = build();

		expect(await denyDial(config, ADDR)).toBe(true);

		// What Network does when the operator adds a bootstrap entry at runtime.
		configuredBootstrapPeerIDs.add(PEER);

		expect(await denyDial(config, ADDR)).toBe(false);
	});

	it('takes the bypass back when the peer stops being configured', async () => {
		const { config, configuredBootstrapPeerIDs } = build();
		configuredBootstrapPeerIDs.add(PEER);
		expect(await denyDial(config, ADDR)).toBe(false);

		// pruneConfiguredBootstrapPeer / closeUnwantedBootstrapDial.
		configuredBootstrapPeerIDs.delete(PEER);

		expect(await denyDial(config, ADDR)).toBe(true);
	});

	it('negative control: a copied set leaves the gater on the startup snapshot', async () => {
		// The shape this replaced — `new Set(bootstrapPeerIDs)` on the Network — kept the
		// gater answering from whatever was configured at startup, forever.
		const { config, configuredBootstrapPeerIDs } = build();
		const copy = new Set(configuredBootstrapPeerIDs);

		copy.add(PEER);

		expect(copy.has(PEER)).toBe(true);
		expect(await denyDial(config, ADDR)).toBe(true);
	});
});
