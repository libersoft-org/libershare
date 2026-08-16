import { describe, it, expect } from 'bun:test';
import { applyGossipsubOutboundPushPatch } from '../../../src/protocol/gossipsub-patches.ts';

/**
 * The outbound-push wrapper is installed on the SHARED OutboundStream prototype, so
 * it survives a node restart while the pubsub instance does not. It must therefore
 * evict dead streams from the CURRENT gossipsub, not from the instance that happened
 * to install it — otherwise the eviction is a silent no-op after every restart and
 * gossipsub keeps writing to a closed stream.
 */

/** Stands in for OutboundStream: one shared prototype, push() rejecting asynchronously. */
class FakeOutboundStream {
	async push(): Promise<void> {
		throw new Error('stream closed');
	}
	async close(): Promise<void> {}
}

/** Stands in for GossipSub: only the outbound stream map the patch reaches into. */
function fakePubsub(peerID: string): { streamsOutbound: Map<string, FakeOutboundStream>; stream: FakeOutboundStream } {
	const stream = new FakeOutboundStream();
	return { streamsOutbound: new Map([[peerID, stream]]), stream };
}

describe('gossipsub outbound push patch across a restart', () => {
	it('evicts the dead stream from the pubsub that owns it', async () => {
		const first = fakePubsub('peer-old');
		applyGossipsubOutboundPushPatch(first);

		// Restart: new pubsub, same OutboundStream prototype (already wrapped).
		const second = fakePubsub('peer-new');
		applyGossipsubOutboundPushPatch(second);

		// gossipsub's sendRpc ignores the returned promise; the wrapper's catch is what
		// performs the eviction, so give it a turn to run.
		void second.stream.push();
		await Promise.resolve();
		await Promise.resolve();

		expect(second.streamsOutbound.has('peer-new')).toBe(false);
		expect(first.streamsOutbound.has('peer-old')).toBe(true);
	});
});
