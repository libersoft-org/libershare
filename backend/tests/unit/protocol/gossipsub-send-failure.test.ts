import { describe, expect, it } from 'bun:test';
import { dirname, join } from 'node:path';
import { decode } from 'it-length-prefixed';
import { TypedEventEmitter } from 'main-event';
import type { Uint8ArrayList } from 'uint8arraylist';

/**
 * The backend used to wrap gossipsub's outbound push because a failed write escaped as an
 * unhandled rejection and dropped the control messages riding on it. The official package
 * pushes synchronously inside a try/catch in `sendRpc`, so the wrapper was removed; this pins
 * that behaviour of the real package, so an upgrade that loses it fails here instead of in the
 * field.
 */
describe('gossipsub sendRpc on a failing outbound stream', () => {
	async function load(): Promise<{ GossipSub: any; RPC: any }> {
		const dist = dirname(Bun.resolveSync('@libp2p/gossipsub', import.meta.dir));
		const { GossipSub } = await import(join(dist, 'gossipsub.js'));
		const { RPC } = await import(join(dist, 'message/rpc.js'));
		return { GossipSub, RPC };
	}

	class RawStream extends EventTarget {
		protocol = '/floodsub/1.0.0';
		frames: Uint8Array[] = [];
		failWrites = false;
		send(data: Uint8Array | Uint8ArrayList): void {
			if (this.failWrites) throw new Error('StreamStateError: stream closed');
			this.frames.push(data.subarray().slice());
		}
	}

	async function router(): Promise<any> {
		const { GossipSub } = await load();
		const events = new TypedEventEmitter();
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
			mesh: new Map(),
			safeDispatchEvent: events.safeDispatchEvent.bind(events),
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
		expect(replacement.frames).toHaveLength(1);
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
		expect(replacement.frames).toHaveLength(1);
		replacement.dispatchEvent(new Event('close'));
		expect(self.streamsOutbound.size).toBe(0);
	});

	it('sends queued control and gossip exactly once after a failed write', async () => {
		const { RPC } = await load();
		const self = await router();
		const first = new RawStream();
		await self.createOutboundStream('peer-a', { newStream: async () => first });
		const control = { graft: [{ topicID: 'lish/x' }], prune: [{ topicID: 'lish/left' }] };
		const ihave = [{ topicID: 'lish/x', messageIDs: [new Uint8Array([1])] }];
		self.mesh.set('lish/x', new Set(['peer-a']));
		self.control.set('peer-a', control);
		self.gossip.set('peer-a', ihave);
		first.failWrites = true;

		expect(self.sendRpc('peer-a', { subscriptions: [], messages: [] })).toBe(false);
		expect(first.frames).toHaveLength(0);
		expect(self.control.get('peer-a')).toBe(control);
		expect(self.gossip.get('peer-a')).toBe(ihave);

		first.dispatchEvent(new Event('close'));
		const replacement = new RawStream();
		await self.createOutboundStream('peer-a', { newStream: async () => replacement });
		expect(self.sendRpc('peer-a', { subscriptions: [], messages: [] })).toBe(true);
		expect(replacement.frames).toHaveLength(1);
		expect(self.control.has('peer-a')).toBe(false);
		expect(self.gossip.has('peer-a')).toBe(false);

		expect(self.sendRpc('peer-a', { subscriptions: [], messages: [] })).toBe(true);
		const sent = [...decode(replacement.frames)].map(frame => RPC.decode(frame));
		expect(sent).toHaveLength(2);
		expect(sent[0].control.graft).toEqual(control.graft);
		expect(sent[0].control.prune.map((prune: { topicID: string }) => prune.topicID)).toEqual(['lish/left']);
		expect(sent[0].control.ihave).toEqual(ihave);
		expect(sent[1].control).toBeUndefined();
		replacement.dispatchEvent(new Event('close'));
	});
});
