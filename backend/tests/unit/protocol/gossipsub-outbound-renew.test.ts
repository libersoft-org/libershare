import { describe, expect, it } from 'bun:test';
import { applyGossipsubOutboundRenewPatch } from '../../../src/protocol/gossipsub-patches.ts';

/**
 * gossipsub's own behaviour, reduced to what matters here: one outbound stream per peer, a new connection is skipped
 * while one exists, and the entry goes when its stream closes.
 */
function fakeGossipsub() {
	const queued: Array<{ peerId: string; connection: unknown }> = [];
	const pubsub: any = {
		peers: new Map<string, string>(),
		streamsOutbound: new Map<string, any>(),
		outboundInflightQueue: { push: (item: any) => queued.push(item) },
		isStarted: () => true,
		async createOutboundStream(peerId: string, connection: any) {
			if (this.streamsOutbound.has(peerId)) return;
			const rawStream = new EventTarget();
			const stream = { rawStream, connection };
			this.streamsOutbound.set(peerId, stream);
			rawStream.addEventListener('close', () => {
				if (this.streamsOutbound.get(peerId) === stream) this.streamsOutbound.delete(peerId);
			});
		},
	};
	return { pubsub, queued };
}

describe('gossipsub outbound stream renewal', () => {
	it('opens a stream on the live connection when the old one dies while the peer stays connected', async () => {
		const { pubsub, queued } = fakeGossipsub();
		const live = { status: 'open', timeline: { open: 3000 } };
		// The dying connection still reads as open when its stream closes, and so does another one from before the
		// peer came back; both are listed first.
		const dying = { status: 'open', timeline: { open: 1000 } };
		const stale = { status: 'open', timeline: { open: 2000 } };
		applyGossipsubOutboundRenewPatch(pubsub, () => [dying, stale, live]);
		pubsub.peers.set('peer-a', 'peer-a');
		await pubsub.createOutboundStream('peer-a', dying);
		// The peer came back on a new connection: skipped while the old stream exists.
		await pubsub.createOutboundStream('peer-a', live);
		expect(queued).toHaveLength(0);
		pubsub.streamsOutbound.get('peer-a').rawStream.dispatchEvent(new Event('close'));
		await Bun.sleep(5);
		expect(queued).toEqual([{ peerId: 'peer-a', connection: live }]);
	});

	it('does nothing for a peer that is gone or already has a new stream', async () => {
		const { pubsub, queued } = fakeGossipsub();
		applyGossipsubOutboundRenewPatch(pubsub, () => [{ status: 'open' }]);
		pubsub.peers.set('peer-b', 'peer-b');
		await pubsub.createOutboundStream('peer-b', {});
		pubsub.peers.delete('peer-b');
		pubsub.streamsOutbound.get('peer-b').rawStream.dispatchEvent(new Event('close'));
		await Bun.sleep(5);
		expect(queued).toHaveLength(0);
	});
});
