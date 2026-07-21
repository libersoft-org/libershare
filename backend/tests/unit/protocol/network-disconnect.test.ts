import { describe, it, expect } from 'bun:test';
import { KEEP_ALIVE } from '@libp2p/interface';
import { Network } from '../../../src/protocol/network.ts';

/**
 * Unit tests for Network.disconnectPeer tag hygiene: hanging up a peer must
 * remove BOTH keep-alive tags — the custom 'keep-alive-fleet' tag and the
 * native libp2p KEEP_ALIVE tag. Leaving either behind makes libp2p re-dial
 * the peer right after the hangUp, silently undoing the disconnect.
 */

const PEER_ID = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';

function makeNetwork() {
	const merges: Array<{ tags: Record<string, unknown> }> = [];
	const hungUp: string[] = [];
	const network = Object.create(Network.prototype) as Network;
	(network as any).node = {
		peerStore: {
			async merge(_pid: unknown, patch: { tags: Record<string, unknown> }): Promise<void> {
				merges.push(patch);
			},
		},
		async hangUp(pid: { toString(): string }): Promise<void> {
			hungUp.push(pid.toString());
		},
	};
	return { network, merges, hungUp };
}

describe('Network.disconnectPeer — keep-alive tag removal', () => {
	it('clears both keep-alive-fleet and native KEEP_ALIVE tags before hanging up', async () => {
		const { network, merges, hungUp } = makeNetwork();
		await network.disconnectPeer(PEER_ID);
		expect(merges.length).toBe(1);
		const tags = merges[0]!.tags;
		expect(Object.keys(tags)).toContain('keep-alive-fleet');
		expect(Object.keys(tags)).toContain(KEEP_ALIVE);
		expect(tags['keep-alive-fleet']).toBeUndefined();
		expect(tags[KEEP_ALIVE]).toBeUndefined();
		expect(hungUp).toEqual([PEER_ID]);
	});

	it('still hangs up when tag removal fails', async () => {
		const { network, hungUp } = makeNetwork();
		(network as any).node.peerStore.merge = async (): Promise<void> => {
			throw new Error('merge failed');
		};
		await network.disconnectPeer(PEER_ID);
		expect(hungUp).toEqual([PEER_ID]);
	});

	it('is a no-op for an invalid peer id', async () => {
		const { network, merges, hungUp } = makeNetwork();
		await network.disconnectPeer('not-a-peer-id');
		expect(merges).toEqual([]);
		expect(hungUp).toEqual([]);
	});
});
