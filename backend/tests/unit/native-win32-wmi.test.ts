import { describe, expect, test } from 'bun:test';
import { Worker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { windowsOraclePath } from '../helpers/windows-powershell-oracle.ts';
import { classifyWmiNext, openWmiConnection, wmiMethodResult } from '../../src/native/win32/wmi.ts';
import type { WmiRow } from '../../src/native/win32/wmi-values.ts';

async function workerRead<T>(body: string): Promise<T> {
	const source = new URL('../../src/native/win32/wmi.ts', import.meta.url).href;
	const worker = new Worker(`import { parentPort } from 'node:worker_threads'; import { openWmiConnection } from ${JSON.stringify(source)}; try { const result = (() => { ${body} })(); parentPort.postMessage({result}); } catch(error) { parentPort.postMessage({error:String(error)}); }`, { eval: true });
	try {
		return await new Promise<T>((resolve, reject) => {
			worker.once('error', reject);
			worker.once('message', (message: { result?: T; error?: string }) => (message.error ? reject(new Error(message.error)) : resolve(message.result!)));
			worker.once('exit', code => {
				if (code !== 0) reject(new Error(`WMI worker exited ${code}`));
			});
		});
	} finally {
		await worker.terminate();
	}
}

describe('WMI enumeration boundaries', () => {
	test('accepts only a complete row or the explicit end marker', () => {
		expect(classifyWmiNext(0, 1, true)).toBe('row');
		expect(classifyWmiNext(1, 0, false)).toBe('end');
		for (const [hr, count, object] of [
			[0, 0, false],
			[0, 1, false],
			[1, 1, true],
			[0x40004, 0, false],
			[-2147217385, 0, false],
			[-2147023174, 0, false],
		] as const)
			expect(() => classifyWmiNext(hr, count, object)).toThrow('Next');
	});

	test('refuses blocking WMI calls on the main thread', () => {
		expect(() => openWmiConnection()).toThrow('worker');
	});

	test('does not confuse a successful transport with a successful provider method', () => {
		expect(wmiMethodResult(0, { variantType: 3, cimType: 19, value: 5 })).toEqual({ hresult: 0, returnValue: 5, outcome: 'failed' });
		expect(wmiMethodResult(0, { variantType: 3, cimType: 19, value: -1 })).toEqual({ hresult: 0, returnValue: 0xffffffff, outcome: 'failed' });
		expect(wmiMethodResult(0x800706ba, null).outcome).toBe('unknown');
		expect(wmiMethodResult(0x80041008, null).outcome).toBe('rejected');
		expect(wmiMethodResult(0, { variantType: 8, cimType: 8, value: '0' }).outcome).toBe('unknown');
	});
});

describe.skipIf(process.platform !== 'win32')('WMI network reads (live)', () => {
	test('matches the Windows network cmdlet with IncludeHidden context', async () => {
		const properties = ['InterfaceIndex', 'Hidden', 'Virtual', 'NetworkAddresses', 'NdisPhysicalMedium'];
		const rows = await workerRead<WmiRow[]>(`const connection = openWmiConnection(); try { return connection.query('SELECT * FROM MSFT_NetAdapter', ${JSON.stringify(properties)}, { IncludeHidden: true }); } finally { connection.close(); }`);
		const command = "$ErrorActionPreference='Stop'; $rows=@(Get-NetAdapter -IncludeHidden | Select-Object InterfaceIndex,Hidden,Virtual,NetworkAddresses,NdisPhysicalMedium); ConvertTo-Json -InputObject $rows -Depth 8 -Compress";
		const oracle = JSON.parse(execFileSync(windowsOraclePath(), ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 20000 })) as Record<string, unknown>[];
		const normalize = (values: Record<string, unknown>[]): string => JSON.stringify(values.map(value => Object.fromEntries(properties.map(name => [name, value[name]]))).sort((a, b) => Number(a['InterfaceIndex']) - Number(b['InterfaceIndex'])));
		const actual = rows.map(value => Object.fromEntries(properties.map(name => [name, value[name]!.value])));
		expect(rows.length).toBe(oracle.length);
		expect(normalize(actual) === normalize(oracle)).toBe(true);
	}, 30000);

	test('preserves PolicyStore, relative paths and enumeration failures', async () => {
		const result = await workerRead<{ active: number; persistent: number; roundTrip: boolean; empty: number; invalidThrows: boolean; closedThrows: boolean }>(`
			const c = openWmiConnection(); let invalidThrows = false, roundTrip = true;
			try {
				const active = c.query('SELECT * FROM MSFT_NetIPAddress', ['IPAddress','__RELPATH'], {PolicyStore:'ActiveStore'});
				const persistent = c.query('SELECT * FROM MSFT_NetIPAddress', ['IPAddress'], {PolicyStore:'PersistentStore'});
				if(active.length) roundTrip = c.get(active[0].__RELPATH.value, ['IPAddress'], {PolicyStore:'ActiveStore'}).IPAddress.value === active[0].IPAddress.value;
				const empty = c.query('SELECT * FROM MSFT_NetAdapter WHERE InterfaceIndex=4294967295', ['InterfaceIndex']).length;
				try { c.query('SELECT * FROM MSFT_NoSuchTestClass', ['Name']); } catch { invalidThrows=true; }
				c.close(); let closedThrows=false; try { c.query('SELECT * FROM MSFT_NetAdapter', ['InterfaceIndex']); } catch { closedThrows=true; }
				return {active:active.length,persistent:persistent.length,roundTrip,empty,invalidThrows,closedThrows};
			} finally { c.close(); }
		`);
		expect(result.active).toBeGreaterThan(0);
		expect(result.persistent).toBeGreaterThanOrEqual(0);
		expect(result.roundTrip).toBe(true);
		expect(result.empty).toBe(0);
		expect(result.invalidThrows).toBe(true);
		expect(result.closedThrows).toBe(true);
	}, 30000);

	test('separates method HRESULT from ReturnValue using the read-only GetOwner method', async () => {
		const result = await workerRead<{ hresult: number; returnValue: number | null; outcome: string }>(`const c=openWmiConnection('ROOT\\\\CIMV2'); try { return c.execMethod('Win32_Process.Handle="'+process.pid+'"', 'GetOwner', {}); } finally { c.close(); }`);
		expect(result).toEqual({ hresult: 0, returnValue: 0, outcome: 'ok' });
	}, 30000);
});
