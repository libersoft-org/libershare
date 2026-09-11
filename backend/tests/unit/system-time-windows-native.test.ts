import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { setTimeout as scheduleTimeout, clearTimeout as cancelTimeout } from 'node:timers';
import { getSystemTimeStatus, setSystemClock } from '../../src/system-time.ts';
import { parseWindowsServiceRunning, parseWindowsServiceState, parseWindowsTimeZone, readWindowsTimeServiceRunning, readWindowsTimeZone, readWindowsStatus, windowsClockRefusal, windowsServiceRunning, type WindowsModeState } from '../../src/system-time-windows.ts';

function zoneBuffer(disabled = false): Uint8Array {
	const bytes = new Uint8Array(432);
	const view = new DataView(bytes.buffer);
	view.setInt32(0, -60, true);
	view.setInt32(84, 0, true);
	view.setInt32(168, -60, true);
	bytes.set(Buffer.from('Central Europe Standard Time\0', 'utf16le'), 172);
	view.setUint8(428, disabled ? 1 : 0);
	return bytes;
}

describe('Windows native time structures', () => {
	it.each([
		[0, 60],
		[1, 60],
		[2, 120],
	])('uses the OS bias for current timezone state %i', (state, offset) => {
		expect(parseWindowsTimeZone(zoneBuffer(), state!)).toMatchObject({ windowsId: 'Central Europe Standard Time', utcOffsetMinutes: offset, daylightDisabled: false });
	});
	it('preserves a disabled-DST standard offset despite the corresponding IANA summer rule', () => {
		expect(parseWindowsTimeZone(zoneBuffer(true), 1)).toMatchObject({ utcOffsetMinutes: 60, daylightDisabled: true });
	});
	it('does not apply seasonal biases to TIME_ZONE_ID_UNKNOWN', () => {
		const bytes = zoneBuffer();
		new DataView(bytes.buffer).setInt32(84, 30, true);
		expect(parseWindowsTimeZone(bytes, 0)?.utcOffsetMinutes).toBe(60);
	});
	it('rejects failed or incomplete timezone reads', () => {
		expect(parseWindowsTimeZone(zoneBuffer(), 0xffffffff)).toBeNull();
		expect(parseWindowsTimeZone(new Uint8Array(431), 1)).toBeNull();
	});
	it.each([
		[1, false],
		[4, true],
		[2, null],
		[3, null],
		[5, null],
		[6, null],
		[7, null],
	])('distinguishes SCM state %i from service start policy', (state, running) => {
		const bytes = new Uint8Array(36);
		new DataView(bytes.buffer).setUint32(4, state as number, true);
		expect(parseWindowsServiceRunning(bytes)).toBe(running as boolean | null);
	});
	it('rejects an incomplete SCM status buffer', () => expect(parseWindowsServiceRunning(new Uint8Array(35))).toBeNull());
});

describe('SCM read handle lifetime', () => {
	it.each(['running', 'stopped', 'query-failed', 'open-failed'])(
		'opens only query access and releases native handles: %s',
		async mode => {
			const script = `
			import {mock} from 'bun:test';
			const ffi=await import('bun:ffi');const calls=[];
			mock.module('bun:ffi',()=>({...ffi,dlopen:()=>({symbols:{
				OpenSCManagerW:(_machine,_database,access)=>{calls.push(['manager',access]);return 1n;},
				OpenServiceW:(_manager,_name,access)=>{calls.push(['service',access]);return ${JSON.stringify(mode)}==='open-failed'?0n:2n;},
				QueryServiceStatusEx:(_service,level,buffer,size)=>{calls.push(['query',level,size]);new DataView(ffi.toArrayBuffer(buffer,0,size)).setUint32(4,${JSON.stringify(mode)}==='running'?4:1,true);return ${JSON.stringify(mode)}==='query-failed'?0:1;},
				CloseServiceHandle:handle=>{calls.push(['close',Number(handle)]);return 1;},
			}})}));
			const {readWindowsTimeServiceRunning}=await import('./src/system-time-windows.ts');
			console.log(JSON.stringify({running:readWindowsTimeServiceRunning(),calls}));
		`;
			const child = Bun.spawn([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' });
			const deadline = scheduleTimeout(() => child.kill('SIGKILL'), 5000);
			let result;
			try {
				const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
				if (exitCode !== 0) throw new Error(`SCM fixture exited ${exitCode}: ${stderr}`);
				expect(stderr).toBe('');
				result = JSON.parse(stdout);
			} finally {
				cancelTimeout(deadline);
				if (child.exitCode === null) {
					child.kill('SIGKILL');
					await child.exited;
				}
			}
			expect(result.running).toBe(mode === 'running' ? true : mode === 'stopped' ? false : null);
			expect(result.calls.slice(0, 2)).toEqual([
				['manager', 1],
				['service', 4],
			]);
			expect(result.calls.slice(mode === 'open-failed' ? 2 : 3)).toEqual(
				mode === 'open-failed'
					? [['close', 1]]
					: [
							['close', 2],
							['close', 1],
						]
			);
		},
		10000
	);
});

it('does not offer clock or timezone writes when the native timezone read failed', async () => {
	const status = await readWindowsStatus(
		() => null,
		async () => ({ mode: 'manual', start: 'disabled', membership: 'standalone', service: 'stopped' })
	);
	expect(status.capabilities.setClock).toBe(false);
	expect(status.capabilities.setTimezone).toBe(false);
	const assembled = await getSystemTimeStatus(async () => status);
	let commands = 0;
	const result = await setSystemClock(
		12,
		0,
		0,
		async () => assembled,
		async () => {
			commands++;
			return { kind: 'ok', output: '' };
		}
	);
	expect(result.success).toBe(false);
	expect(commands).toBe(0);
});

/**
 * A standard (non-elevated) Windows user cannot open W32Time through the SCM at all -
 * measured error 5 on Windows 11 for both `sc query w32time` and the
 * QueryServiceStatusEx probe. Switching the capability off for that turned a refused
 * READ into "this host has no facility for setting the clock", a claim about the host
 * that was simply untrue. The write is what reports the missing privilege.
 */
it('still offers the clock when the service state could not be read', async () => {
	const status = await readWindowsStatus(
		() => ({ windowsId: 'UTC', utcOffsetMinutes: 0, daylightDisabled: true }),
		async (): Promise<WindowsModeState> => ({ mode: 'manual', start: 'automatic', membership: 'standalone', service: 'unreadable' })
	);
	expect(status.capabilities.setClock).toBe(true);
});

/**
 * The capability is the FACILITY, so it stays on; what a service in motion or running
 * against policy forbids is this particular write, and that is decided at write time with
 * its own reason. The two used to be one boolean, which is how a refused SCM read came
 * back to the user as "this host has no facility for setting the clock".
 */
it('offers the clock facility but refuses the write while a disabled-policy service still runs', async () => {
	const mode = async (): Promise<WindowsModeState> => ({ mode: 'manual', start: 'disabled', membership: 'standalone', service: 'running' });
	const status = await readWindowsStatus(() => ({ windowsId: 'UTC', utcOffsetMinutes: 0, daylightDisabled: true }), mode);
	expect(status.ntpEnabled).toBe(false);
	expect(status.capabilities.setClock).toBe(true);
	expect(windowsClockRefusal(await mode())).toContain('would overwrite a hand-set clock');
});

/**
 * The transition the old model could not see: `SERVICE_START_PENDING` and
 * `SERVICE_STOP_PENDING` both read as neither running nor stopped, and were treated as
 * "stopped, safe to write". "Start type disabled" and "already stopped" are not the same
 * state - a service still on its way up finishes a second later and steps the clock back.
 */
it('refuses a clock write while the service is starting or stopping', () => {
	expect(windowsClockRefusal({ mode: 'manual', start: 'disabled', membership: 'standalone', service: 'changing' })).toContain('starting or stopping');
	expect(windowsClockRefusal({ mode: 'none', start: 'disabled', membership: 'standalone', service: 'changing' })).toContain('starting or stopping');
});

/** An unreadable state says nothing about the host, so it must not refuse: the write reports the real reason. */
it('does not refuse a clock write merely because the service state could not be read', () => {
	expect(windowsClockRefusal({ mode: 'manual', start: 'disabled', membership: 'standalone', service: 'unreadable' })).toBeNull();
	expect(windowsClockRefusal({ mode: 'manual', start: 'automatic', membership: 'standalone', service: 'stopped' })).toBeNull();
});

it('reads each SCM state as itself, not as an unknown', () => {
	const status = (state: number): Uint8Array => {
		const bytes = new Uint8Array(36);
		new DataView(bytes.buffer).setUint32(4, state, true);
		return bytes;
	};
	expect(parseWindowsServiceState(status(4))).toBe('running');
	expect(parseWindowsServiceState(status(1))).toBe('stopped');
	// 2 START_PENDING, 3 STOP_PENDING, 5 CONTINUE_PENDING, 6 PAUSE_PENDING, 7 PAUSED
	for (const state of [2, 3, 5, 6, 7]) expect(parseWindowsServiceState(status(state))).toBe('changing');
	expect(parseWindowsServiceState(new Uint8Array(8))).toBe('unreadable');
	expect(windowsServiceRunning('changing')).toBeNull();
	expect(windowsServiceRunning('unreadable')).toBeNull();
	expect(windowsServiceRunning('running')).toBe(true);
	expect(windowsServiceRunning('stopped')).toBe(false);
});

describe.if(process.platform === 'win32')('Windows native reads on the live host', () => {
	it('reads service status and effective timezone without writing settings', () => {
		// null when the process is not elevated: a standard user may not query W32Time.
		expect(['boolean', 'object']).toContain(typeof readWindowsTimeServiceRunning());
		const zone = readWindowsTimeZone();
		expect(zone).not.toBeNull();
		expect(Number.isFinite(zone?.utcOffsetMinutes)).toBe(true);
	});
});
