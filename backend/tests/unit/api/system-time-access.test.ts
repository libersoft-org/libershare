import { describe, expect, it } from 'bun:test';
import type { SystemTimeResult, SystemTimeStatus } from '@shared';
import { APIServer } from '../../../src/api/api.ts';
import { createTimeApiHandlers, timeStatusForClient } from '../../../src/api/system-time.ts';

const status: SystemTimeStatus = {
	supported: true,
	nowMs: Date.UTC(2026, 0, 1),
	timezone: 'UTC',
	utcOffsetMinutes: 0,
	timezoneSource: 'intl',
	ntpEnabled: true,
	ntpSynchronized: true,
	ntpServer: 'ntp.example.org',
	capabilities: { setClock: true, setTimezone: true, setNtpServer: true, setNtpEnabled: true },
};
const ok: SystemTimeResult = { success: true, outcome: 'ok', message: null };
const writes = ['setClock', 'setTimezone', 'setNtpServer', 'setNtpEnabled', 'applyTimeSettings'] as const;

describe('system time API authorization', () => {
	for (const [authenticated, local] of [
		[false, false],
		[false, true],
		[true, false],
		[true, true],
	] as const) {
		it(`guards every time mutation with token=${authenticated} and local=${local}`, async () => {
			const called: string[] = [];
			const system = {
				getTime: async () => status,
				listTimezones: () => ['UTC'],
				setClock: async () => {
					called.push('setClock');
					return ok;
				},
				setTimezone: async () => {
					called.push('setTimezone');
					return ok;
				},
				setNtpServer: async () => {
					called.push('setNtpServer');
					return ok;
				},
				setNtpEnabled: async () => {
					called.push('setNtpEnabled');
					return ok;
				},
				applyTimeSettings: async () => {
					called.push('applyTimeSettings');
					return ok;
				},
			};
			const handlers = createTimeApiHandlers(system, authenticated);
			const client = { data: { isLocalClient: local } };
			for (const method of writes) {
				const result = await handlers[`system.${method}`]!({}, client);
				expect(result.success).toBe(authenticated && local);
				expect(result.outcome).toBe(authenticated && local ? 'ok' : 'permission-denied');
			}
			expect(called).toEqual(authenticated && local ? [...writes] : []);
			const read: SystemTimeStatus = await handlers['system.getTime']!({}, client);
			expect(read.ntpServer).toBe(status.ntpServer);
			expect(read.ntpEnabled).toBe(true);
			expect(Object.values(read.capabilities).every(Boolean)).toBe(authenticated && local);
			expect(handlers['system.listTimezones']!({}, client)).toEqual(['UTC']);
		});
	}

	it('does not mutate the shared status or enable an unsupported host operation', () => {
		const restricted = timeStatusForClient(status, true, false);
		expect(Object.values(restricted.capabilities)).toEqual([false, false, false, false]);
		expect(status.capabilities.setClock).toBe(true);
		const limited = { ...status, capabilities: { ...status.capabilities, setNtpEnabled: false } };
		expect(timeStatusForClient(limited, true, true)).toBe(limited);
	});

	it('applies client capabilities to real API broadcasts and survives a dead recipient', () => {
		const localMessages: string[] = [];
		const remoteMessages: string[] = [];
		const makeClient = (local: boolean, messages: string[]) => ({
			data: { isLocalClient: local, subscribedEvents: new Set(['system:timeChanged']) },
			send: (message: string) => messages.push(message),
		});
		const local = makeClient(true, localMessages);
		const remote = makeClient(false, remoteMessages);
		const dead = {
			...makeClient(true, []),
			send: () => {
				throw new Error('closed');
			},
		};
		const api = Object.create(APIServer.prototype) as APIServer;
		Object.assign(api, { apiToken: 'fixture-token', clients: new Set([local, dead, remote]) });
		api.broadcastEvent('system:timeChanged', status);
		expect(JSON.parse(localMessages[0]!).data.capabilities.setClock).toBe(true);
		expect(JSON.parse(remoteMessages[0]!).data.capabilities.setClock).toBe(false);
		Object.assign(api, { apiToken: undefined });
		api.broadcastEvent('system:timeChanged', status);
		expect(JSON.parse(localMessages[1]!).data.capabilities.setClock).toBe(false);
		expect(JSON.parse(remoteMessages[1]!).data.ntpServer).toBe(status.ntpServer);
	});
});
