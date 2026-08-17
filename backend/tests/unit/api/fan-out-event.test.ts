import { describe, expect, it } from 'bun:test';
import { fanOutEvent, type BroadcastTarget } from '../../../src/api/api.ts';

/** A client that records what it received, or throws instead of receiving. */
function client(events: string[], received: string[], throws = false): BroadcastTarget {
	return {
		data: { subscribedEvents: new Set(events) },
		send: (msg: string) => {
			if (throws) throw new Error('WebSocket is already in CLOSING or CLOSED state');
			received.push(msg);
		},
	};
}

describe('fanOutEvent', () => {
	it('delivers only to the clients that subscribed', () => {
		const a: string[] = [];
		const b: string[] = [];
		const sent = fanOutEvent([client(['system:timeChanged'], a), client(['transfer.progress'], b)], 'system:timeChanged', 'payload');
		expect(sent).toBe(1);
		expect(a).toEqual(['payload']);
		expect(b).toEqual([]);
	});

	it('delivers to a wildcard subscriber', () => {
		const a: string[] = [];
		expect(fanOutEvent([client(['*'], a)], 'system:timeChanged', 'payload')).toBe(1);
		expect(a).toEqual(['payload']);
	});

	/**
	 * The isolation this exists for. Without it the throw aborts the loop, so every
	 * client behind the dead one silently misses the event and the exception escapes
	 * into whichever operation happened to trigger the broadcast.
	 */
	it('keeps delivering after a client whose socket has gone away', () => {
		const before: string[] = [];
		const after: string[] = [];
		const clients = [client(['e'], before), client(['e'], [], true), client(['e'], after)];
		expect(fanOutEvent(clients, 'e', 'payload')).toBe(2);
		expect(before).toEqual(['payload']);
		expect(after).toEqual(['payload']);
	});

	it('never lets a failing client throw at the caller', () => {
		expect(() => fanOutEvent([client(['e'], [], true)], 'e', 'payload')).not.toThrow();
		expect(fanOutEvent([client(['e'], [], true)], 'e', 'payload')).toBe(0);
	});

	it('counts nothing when there are no clients at all', () => {
		expect(fanOutEvent([], 'e', 'payload')).toBe(0);
	});
});
