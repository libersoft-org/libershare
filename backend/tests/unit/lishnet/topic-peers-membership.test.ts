import { describe, it, expect } from 'bun:test';
import { Networks } from '../../../src/lishnet/lishnets.ts';

/**
 * Networks.getTopicPeers / getTopicPeersInfo answer for THIS node's membership.
 *
 * gossipsub keeps returning a peer that is still subscribed to a topic after we
 * unsubscribe from it, so the raw protocol-level reading describes the topic, not
 * us. A network the user disabled must report no participants, or the UI states a
 * membership that has ended.
 */
describe('Networks.getTopicPeers — scoped to networks this node is in', () => {
	const NET = 'aaaaaaaa-0000-0000-0000-000000000000';
	const PEER = '12D3KooWTestPeerIdenticalAcrossBothReadings000000000';

	function bare(joined: string[]) {
		const networks = Object.create(Networks.prototype) as Networks;
		// The protocol layer answers regardless of our own subscription — that is the
		// behaviour being filtered, so the mock reproduces it rather than hiding it.
		(networks as any).network = {
			getTopicPeers: () => [PEER],
			getTopicPeersInfo: () => [{ peerID: PEER, direction: 'outbound' }],
		};
		(networks as any).joinedNetworks = new Set(joined);
		return networks;
	}

	it('reports the subscribers of a network it is in', () => {
		const networks = bare([NET]);
		expect(networks.getTopicPeers(NET)).toEqual([PEER]);
		expect(networks.getTopicPeersInfo(NET)).toHaveLength(1);
	});

	it('reports none for a network it has left, though the peer is still in the topic', () => {
		const networks = bare([]);
		expect((networks as any).network.getTopicPeers()).toEqual([PEER]);
		expect(networks.getTopicPeers(NET)).toEqual([]);
		expect(networks.getTopicPeersInfo(NET)).toEqual([]);
	});

	it('keeps the networks apart — leaving one does not silence the other', () => {
		const OTHER = 'bbbbbbbb-0000-0000-0000-000000000000';
		const networks = bare([OTHER]);
		expect(networks.getTopicPeers(NET)).toEqual([]);
		expect(networks.getTopicPeers(OTHER)).toEqual([PEER]);
	});
});
