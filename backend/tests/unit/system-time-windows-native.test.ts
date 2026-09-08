import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { getSystemTimeStatus, setSystemClock } from '../../src/system-time.ts';
import { parseWindowsServiceRunning, parseWindowsTimeZone, readWindowsTimeServiceRunning, readWindowsTimeZone, readWindowsStatus } from '../../src/system-time-windows.ts';

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
	it.each(['running', 'stopped', 'query-failed', 'open-failed'])('opens only query access and releases native handles: %s', mode => {
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
		const child = Bun.spawnSync([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), timeout: 5000 });
		expect(child.exitCode).toBe(0);
		const result = JSON.parse(child.stdout.toString());
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
	});
});

it('does not offer clock or timezone writes when the native timezone read failed', async () => {
	const status = await readWindowsStatus(
		() => null,
		async () => ({ mode: 'manual', start: 'disabled', membership: 'standalone', running: false })
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

it('does not offer a manual clock while a disabled-policy service is actually still running', async () => {
	const status = await readWindowsStatus(
		() => ({ windowsId: 'UTC', utcOffsetMinutes: 0, daylightDisabled: true }),
		async () => ({ mode: 'manual', start: 'disabled', membership: 'standalone', running: true })
	);
	expect(status.ntpEnabled).toBe(false);
	expect(status.capabilities.setClock).toBe(false);
});

describe.if(process.platform === 'win32')('Windows native reads on the live host', () => {
	it('reads service status and effective timezone without writing settings', () => {
		expect(typeof readWindowsTimeServiceRunning()).toBe('boolean');
		const zone = readWindowsTimeZone();
		expect(zone).not.toBeNull();
		expect(Number.isFinite(zone?.utcOffsetMinutes)).toBe(true);
	});
});
