import { describe, it, expect } from 'bun:test';
import { APIServer } from '../../../src/api/api.ts';

/** A subscribed client that records what it was sent. */
function fakeClient(events: string[]) {
	const sent: string[] = [];
	return { sent, ws: { data: { subscribedEvents: new Set(events) }, send: (m: string) => sent.push(m) } as never };
}

/**
 * Some events exist to tell everybody ELSE what somebody just did. The client that asked
 * for it already has the answer to its own call, and a broadcast on top of that talks over
 * it — a factory reset reloading the very tab that is about to show its result.
 */
describe('APIServer.broadcast — the client that asked is not told again', () => {
	it('skips the initiating client and reaches the others', () => {
		const api = Object.create(APIServer.prototype) as APIServer;
		const initiator = fakeClient(['system:factoryReset']);
		const bystander = fakeClient(['system:factoryReset']);
		(api as any).clients = new Set([initiator.ws, bystander.ws]);

		(api as any).broadcast('system:factoryReset', {}, initiator.ws);

		expect(initiator.sent).toEqual([]);
		expect(bystander.sent).toHaveLength(1);
	});

	it('reaches everybody when no one is excepted', () => {
		const api = Object.create(APIServer.prototype) as APIServer;
		const a = fakeClient(['system:factoryReset']);
		const b = fakeClient(['system:factoryReset']);
		(api as any).clients = new Set([a.ws, b.ws]);

		(api as any).broadcast('system:factoryReset', {});

		expect(a.sent).toHaveLength(1);
		expect(b.sent).toHaveLength(1);
	});

	it('still respects what each client subscribed to', () => {
		const api = Object.create(APIServer.prototype) as APIServer;
		const subscribed = fakeClient(['system:factoryReset']);
		const uninterested = fakeClient(['transfer.download:progress']);
		(api as any).clients = new Set([subscribed.ws, uninterested.ws]);

		(api as any).broadcast('system:factoryReset', {});

		expect(subscribed.sent).toHaveLength(1);
		expect(uninterested.sent).toEqual([]);
	});
});
