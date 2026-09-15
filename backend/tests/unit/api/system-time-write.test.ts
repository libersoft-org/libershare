import { describe, expect, it } from 'bun:test';
import { runTimeWrite } from '../../../src/api/system.ts';
import { remainingSaveBudget, SAVE_BUDGET_MS } from '../../../src/system-time.ts';
import type { SystemTimeResult, SystemTimeStatus } from '@shared';

/** A host with everything available and synchronisation off. */
function statusFixture(): SystemTimeStatus {
	return {
		supported: true,
		nowMs: Date.UTC(2026, 7, 14, 21, 46, 28),
		timezone: 'Europe/Prague',
		utcOffsetMinutes: 120,
		timezoneSource: 'intl',
		ntpEnabled: false,
		ntpSynchronized: null,
		ntpServer: 'ntp1.example.org',
		capabilities: { setClock: true, setTimezone: true, setNtpServer: true, setNtpEnabled: true },
	};
}

const ok: SystemTimeResult = { success: true, outcome: 'ok', message: null };
const denied: SystemTimeResult = { success: false, outcome: 'permission-denied', message: 'nope' };

describe('runTimeWrite', () => {
	/**
	 * The wait has to run from the moment the request arrives, not from the moment it reaches
	 * the head of the queue. Measured against the old behaviour: each save saw a full budget
	 * of its own, so a third request could sit in the queue past the wait the screen allows
	 * and then start changing the host after the user had been told the wait was over.
	 *
	 * Refused, not truncated: at this point nothing has been touched, and the answer belongs
	 * to a caller that has stopped listening.
	 */
	it('does not start a save whose wait ran out while it queued', async () => {
		let clock = 0;
		const ran: string[] = [];
		let release = (): void => {};
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const events: string[] = [];
		const broadcast = (event: string): void => void events.push(event);
		// Both requests are accepted at the same instant, so both deadlines are the same. The
		// first holds the lock and spends the whole of it.
		const first = runTimeWrite(
			async () => {
				await gate;
				clock = SAVE_BUDGET_MS + 1;
				ran.push('first');
				return ok;
			},
			async () => statusFixture(),
			broadcast,
			() => clock
		);
		const second = runTimeWrite(
			async () => {
				ran.push('second');
				return ok;
			},
			async () => statusFixture(),
			broadcast,
			() => clock
		);
		release();
		const [a, b] = await Promise.all([first, second]);
		expect(a).toEqual(ok);
		// The queued one never ran, and says why.
		expect(ran).toEqual(['first']);
		expect(b.success).toBe(false);
		expect(b.message).toContain('waited longer');
		// And nothing was announced on its behalf: there is no new state to announce.
		expect(events).toEqual(['system:timeChanged']);
	});

	/** The ordinary case still has its whole budget once it holds the lock. */
	it('gives a save that did not queue its full allowance', async () => {
		const seen: Array<number | null> = [];
		const res = await runTimeWrite(
			async () => {
				seen.push(remainingSaveBudget());
				return ok;
			},
			async () => statusFixture(),
			() => {},
			() => 0
		);
		expect(res).toEqual(ok);
		expect(seen).toEqual([SAVE_BUDGET_MS]);
	});

	it('announces the freshly read host state after a successful write', async () => {
		const events: Array<{ event: string; data: unknown }> = [];
		const res = await runTimeWrite(
			async () => ok,
			async () => statusFixture(),
			(event, data) => events.push({ event, data })
		);
		expect(res).toEqual(ok);
		expect(events).toHaveLength(1);
		expect(events[0]?.event).toBe('system:timeChanged');
		expect((events[0]?.data as SystemTimeStatus).timezone).toBe('Europe/Prague');
	});

	it('announces nothing when the write changed nothing', async () => {
		const events: string[] = [];
		const res = await runTimeWrite(
			async () => denied,
			async () => statusFixture(),
			event => events.push(event)
		);
		expect(res).toEqual(denied);
		expect(events).toEqual([]);
	});

	/**
	 * A sequence that stopped part-way DID change the host — the service is down, the
	 * start mode is written — so every open window has to be told what it looks like now.
	 * Staying silent because the request failed leaves them showing the state before it.
	 */
	it('announces the real state after a write that failed part-way through', async () => {
		const events: Array<{ event: string; data: unknown }> = [];
		const partial: SystemTimeResult = {
			...denied,
			changed: true,
			stateMayHaveChanged: true,
			steps: [
				{ command: 'sc stop w32time', ok: true },
				{ command: 'sc config w32time start= disabled', ok: false },
			],
		};
		const res = await runTimeWrite(
			async () => partial,
			async () => statusFixture(),
			(event, data) => events.push({ event, data })
		);
		// The failure is still a failure: the refresh reports, it does not reconcile.
		expect(res).toEqual(partial);
		expect(events.map(e => e.event)).toEqual(['system:timeChanged']);
	});

	it('announces the real state even when nothing is known to have succeeded yet', async () => {
		const events: string[] = [];
		const attempted: SystemTimeResult = { ...denied, changed: false, stateMayHaveChanged: true, steps: [{ command: 'sc stop w32time', ok: false }] };
		await runTimeWrite(
			async () => attempted,
			async () => statusFixture(),
			event => events.push(event)
		);
		expect(events).toEqual(['system:timeChanged']);
	});

	/**
	 * The change is already applied on the host when the refresh runs. Letting the
	 * refresh decide the outcome would report an applied clock change as a protocol
	 * error and invite the client to retry it.
	 */
	it('keeps a successful write successful when the refresh read throws', async () => {
		const res = await runTimeWrite(
			async () => ok,
			async () => {
				throw new Error('timedatectl went missing');
			},
			() => {}
		);
		expect(res).toEqual(ok);
	});

	it('keeps a successful write successful when the broadcast throws', async () => {
		const res = await runTimeWrite(
			async () => ok,
			async () => statusFixture(),
			() => {
				throw new Error('socket closed');
			}
		);
		expect(res).toEqual(ok);
	});

	it('lets a genuine failure of the write itself through untouched', async () => {
		const boom = new Error('the write itself blew up');
		expect(
			runTimeWrite(
				() => Promise.reject(boom),
				async () => statusFixture(),
				() => {}
			)
		).rejects.toThrow('the write itself blew up');
	});
});
