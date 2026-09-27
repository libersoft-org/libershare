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

	class RawStream extends EventTarget {
		protocol = '/floodsub/1.0.0';
		writes = 0;
		failWrites = false;
		send(): void {
			if (this.failWrites) throw new Error('StreamStateError: stream closed');
			this.writes++;
		}
	}

	async function router(): Promise<any> {
		const { GossipSub } = await load();
		return Object.assign(Object.create(GossipSub.prototype), {
			isStarted: () => true,
			peers: new Map([['peer-a', {}]]),
			streamsOutbound: new Map(),
			floodsubPeers: new Set(),
			subscriptions: new Set(),
			protocols: ['/floodsub/1.0.0'],
			opts: {},
			control: new Map(),
			gossip: new Map(),
			log: Object.assign(() => {}, { error() {} }),
		});
	}

	it('removes a failed stream on close and sends successfully through its replacement', async () => {
		const self = await router();
		const first = new RawStream();
		await self.createOutboundStream('peer-a', { newStream: async () => first });
		expect(self.streamsOutbound.size).toBe(1);
		first.failWrites = true;
		expect(self.sendRpc('peer-a', { subscriptions: [], messages: [] })).toBe(false);
		first.dispatchEvent(new Event('close'));
		expect(self.streamsOutbound.size).toBe(0);
		expect(self.floodsubPeers.has('peer-a')).toBe(false);
		const replacement = new RawStream();
		await self.createOutboundStream('peer-a', { newStream: async () => replacement });
		expect(self.sendRpc('peer-a', { subscriptions: [], messages: [] })).toBe(true);
		expect(replacement.writes).toBe(1);
	});

	it('a delayed close from a removed stream preserves its new replacement', async () => {
		const self = await router();
		const first = new RawStream();
		await self.createOutboundStream('peer-a', { newStream: async () => first });
		self.streamsOutbound.delete('peer-a');
		self.floodsubPeers.delete('peer-a');
		const replacement = new RawStream();
		await self.createOutboundStream('peer-a', { newStream: async () => replacement });
		const attached = self.streamsOutbound.get('peer-a');
		first.dispatchEvent(new Event('close'));
		expect(self.streamsOutbound.get('peer-a')).toBe(attached);
		expect(self.floodsubPeers.has('peer-a')).toBe(true);
		expect(self.sendRpc('peer-a', { subscriptions: [], messages: [] })).toBe(true);
		expect(replacement.writes).toBe(1);
		replacement.dispatchEvent(new Event('close'));
		expect(self.streamsOutbound.size).toBe(0);
	});

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
