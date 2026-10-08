import { expect, test } from 'bun:test';
import { getSystemTimeStatus } from '../../src/system-time.ts';
import { NativeWorkerChannel } from '../../src/native/worker-host.ts';
import type { PlatformStatus, PlatformStatusReader } from '../../src/system-time-common.ts';

test('time status preserves a fresh snapshot through a real worker timeout and then refreshes', async () => {
	const worker = new NativeWorkerChannel('read', new URL('../helpers/native-blocking-worker.ts', import.meta.url).href);
	const fresh: PlatformStatus = { timezone: 'UTC', utcOffsetMinutes: 0, ntpEnabled: false, ntpSynchronized: false, ntpServer: 'time.example.org', capabilities: { setClock: true, setTimezone: true, setNtpEnabled: true, setNtpServer: true } };
	let block = false;
	const reader: PlatformStatusReader = async () => {
		if (block) await worker.call({ method: 'block', args: { milliseconds: 200, value: null } }, 30);
		return fresh;
	};
	try {
		expect((await getSystemTimeStatus(reader)).stale).toBeUndefined();
		block = true;
		const stale = await getSystemTimeStatus(reader);
		expect(stale.stale).toBe(true);
		expect(stale.ntpServer).toBe('time.example.org');
		expect(stale.timezone).toBe('UTC');
		block = false;
		expect((await getSystemTimeStatus(reader)).stale).toBeUndefined();
		const isolated = await getSystemTimeStatus(async () => {
			throw new Error('First read failed');
		});
		expect(isolated.stale).toBe(true);
		expect(Object.values(isolated.capabilities).every(value => value === false)).toBe(true);
	} finally {
		worker.close();
	}
});
