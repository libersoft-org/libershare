import { describe, expect, it } from 'bun:test';
import { runTimeWrite } from '../../../src/api/system.ts';
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
