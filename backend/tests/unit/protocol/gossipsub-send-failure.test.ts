import { describe, expect, it } from 'bun:test';
import { dirname, join } from 'node:path';

/**
 * The backend used to wrap gossipsub's outbound push because a failed write escaped as an
 * unhandled rejection and dropped the control messages riding on it. The official package
 * pushes synchronously inside a try/catch in `sendRpc`, so the wrapper was removed; this pins
 * that behaviour of the real package, so an upgrade that loses it fails here instead of in the
 * field.
 */
describe('gossipsub sendRpc on a failing outbound stream', () => {
	async function load(): Promise<{ GossipSub: any; OutboundStream: any }> {
		const dist = dirname(Bun.resolveSync('@libp2p/gossipsub', import.meta.dir));
		const { GossipSub } = await import(join(dist, 'gossipsub.js'));
		const { OutboundStream } = await import(join(dist, 'stream.js'));
		return { GossipSub, OutboundStream };
	}

	it('reports the failure, throws nothing and keeps control and gossip for the next send', async () => {
		const { GossipSub, OutboundStream } = await load();
		const rawStream = {
			addEventListener() {},
			send() {
				throw new Error('StreamStateError: stream closed');
			},
		};
		const control = { graft: [{ topicID: 'lish/x' }] };
		const ihave = [{ topicID: 'lish/x', messageIDs: [new Uint8Array([1])] }];
		const log = Object.assign(() => {}, { error() {} });
		const self = {
			streamsOutbound: new Map([['peer-a', new OutboundStream(rawStream, () => {}, {})]]),
			control: new Map([['peer-a', control]]),
			gossip: new Map([['peer-a', ihave]]),
			log,
			piggybackControl() {},
			piggybackGossip() {},
		};

		const sent = GossipSub.prototype.sendRpc.call(self, 'peer-a', { subscriptions: [], messages: [] });

		expect(sent).toBe(false);
		expect(self.control.get('peer-a')).toBe(control);
		expect(self.gossip.get('peer-a')).toBe(ihave);
	});
});
