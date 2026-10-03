import { describe, expect, it } from 'bun:test';
import { isAlreadyJoined, readNetworkState, resolveJoinTarget, readNetworkStateUnlocked, runNetworkMutation } from '../../src/system-network.ts';

describe('network mutation serialisation', () => {
	/** Resolve after the current macrotask queue, so an interleaving has room to happen. */
	function tick(): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, 5));
	}

	it('rejects a second mutation immediately while the first runs', async () => {
		const order: string[] = [];
		const first = runNetworkMutation(async () => {
			order.push('first:start');
			await tick();
			order.push('first:end');
		});
		const refused = await runNetworkMutation(async () => {
			order.push('second:start');
		}).catch(error => error);
		expect(refused.code).toBe('NETCONFIG_BUSY');
		await first;
		expect(order).toEqual(['first:start', 'first:end']);
	});

	it('keeps reads available while a mutation waits for completion', async () => {
		await readNetworkState();
		const order: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const mutation = runNetworkMutation(async () => {
			order.push('apply:start');
			await gate;
			order.push('apply:end');
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				readNetworkState().then(() => order.push('read')),
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error('Read queued behind mutation')), 1000);
				}),
			]);
			expect(order).toEqual(['apply:start', 'read']);
		} finally {
			clearTimeout(timer);
			release();
			await mutation;
		}
	});

	it('keeps the unlocked read off the lock, which would deadlock a mutation', async () => {
		// This is the read the mutation itself performs to answer with the state it
		// left behind. Taking the lock there would make it wait for the mutation it
		// is already inside of, and the request would hang until the test timeout.
		const state = await runNetworkMutation(() => readNetworkStateUnlocked());
		expect(state.known).toBe(true);
	});
});

/**
 * The guard that keeps a join off the network the interface is already on.
 *
 * Its whole reason to exist is that the association cannot then be told apart
 * from the one a new attempt would produce: the first poll sees the still-live
 * old connection and reports success, so a wrong password is never noticed and
 * no rollback runs.
 */
describe('already-joined guard', () => {
	// The DECISION is pinned here. Its call site sits behind a live scan, so only a
	// real adapter exercises it — verified on Windows: a second join of the network
	// the interface was already on came back "already connected to that network".
	it('reads the scan row, which is the freshest statement about this interface', () => {
		expect(isAlreadyJoined({ active: true })).toBe(true);
		expect(isAlreadyJoined({ active: false })).toBe(false);
	});
});

describe('resolveJoinTarget', () => {
	const row = (ssid: string, security: string, bssid: string | null, active = false) => ({ ssid, bssid, signal: 50, secured: security !== '', security, supported: true, active });
	const open = row('Guests', '', null, true);
	const secured = row('Guests', 'WPA2', null);

	it('takes the only row of that name', () => {
		expect(resolveJoinTarget([open, row('Office', 'WPA2', null)], 'Office', null)).toMatchObject({ ssid: 'Office' });
	});

	it('refuses to choose between two networks sharing a name', () => {
		// Picking either would connect the user to something they did not choose and
		// describe it with the other one's security.
		expect(resolveJoinTarget([open, secured], 'Guests', null)).toBe('ambiguous');
		expect(resolveJoinTarget([secured, open], 'Guests', null)).toBe('ambiguous');
	});

	it('tells a gone network apart from an ambiguous one', () => {
		// Two different answers, because they send the user to two different faults.
		expect(resolveJoinTarget([secured], 'Missing', null)).toBeNull();
	});

	it('lets a named access point settle it', () => {
		const withBssid = [row('Guests', '', 'AA:BB:CC:DD:EE:01'), row('Guests', 'WPA2', 'AA:BB:CC:DD:EE:02')];
		expect(resolveJoinTarget(withBssid, 'Guests', 'aa:bb:cc:dd:ee:02')).toMatchObject({ security: 'WPA2' });
		expect(resolveJoinTarget(withBssid, 'Guests', 'AA:BB:CC:DD:EE:99')).toBeNull();
	});
});
