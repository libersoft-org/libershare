import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeMutationHost } from '../../src/native/mutation-host.ts';
import { NativeWorkerChannel } from '../../src/native/worker-host.ts';
import { applyNativeWindowsIPv4, observeNativeWindowsIPv4, type WindowsIPv4MutationDeps } from '../../src/native/win32/network-mutation.ts';
import { isWindowsIPv4Recovery, windowsIPv4Fingerprint, type WindowsIPv4Snapshot } from '../../src/native/win32/network-mutation-state.ts';
import type { WindowsIPv4WriteResult } from '../../src/native/win32/network-mutation-worker.ts';
import { windowsOraclePath } from './windows-powershell-oracle.ts';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'arm64');
assert.equal(process.env['GITHUB_ACTIONS'], 'true');
const guid = process.env['WINDOWS_DNS_FIXTURE_GUID'];
assert.ok(guid && /^\{[a-f0-9-]{36}\}$/i.test(guid));
const directory = await mkdtemp(join(tmpdir(), 'lish-arm64-dns-'));
const host = new NativeMutationHost(directory);
const reader = new NativeWorkerChannel('read');
const writer = new NativeWorkerChannel('mutation');
const read = (): Promise<WindowsIPv4Snapshot> => reader.call({ method: 'win32.network.ipv4.read', args: { guid } }, 15000);
const deps: WindowsIPv4MutationDeps = {
	read: (id, timeoutMs) => reader.call({ method: 'win32.network.ipv4.read', args: { guid: id } }, timeoutMs),
	write: request => writer.call({ method: 'win32.network.ipv4.write', args: request }),
	now: () => performance.now(),
	sleep: ms => Bun.sleep(ms),
	close: () => {},
};

function oracle(): { instance: string; dns: { family: number; servers: string[] }[] } {
	const script = `$ErrorActionPreference='Stop'; $a=@(Get-NetAdapter -IncludeHidden | Where-Object InterfaceGuid -eq '${guid}'); if($a.Count -ne 1){throw 'Fixture identity missing'}; $dns=@(Get-DnsClientServerAddress -InterfaceIndex $a[0].ifIndex | Sort-Object AddressFamily | ForEach-Object { @{family=[int]$_.AddressFamily;servers=@($_.ServerAddresses)} }); @{instance=$a[0].PnPDeviceID;dns=$dns} | ConvertTo-Json -Depth 5 -Compress`;
	const result = JSON.parse(execFileSync(windowsOraclePath(), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000, windowsHide: true }));
	assert.equal(result.instance, process.env['WINDOWS_DNS_FIXTURE_INSTANCE']);
	return result;
}

async function apply(dns: string[], supplied = deps): Promise<void> {
	const result = await host.run(
		{ domain: 'network', operation: 'isolated-dns-smoke', requestHash: 'd'.repeat(64), recoveryData: {}, timeoutMs: 60000 },
		async context => {
			try {
				await applyNativeWindowsIPv4(context, guid!, { mode: 'dhcp', dns }, { addressingChanged: false, requireLease: false }, supplied);
			} catch (error) {
				console.error('DNS action:', error);
				throw error;
			}
		},
		async record => {
			assert.ok(record.recoveryData && typeof record.recoveryData === 'object' && !Array.isArray(record.recoveryData));
			const saved = record.recoveryData['windowsIPv4'];
			assert.ok(isWindowsIPv4Recovery(saved));
			const observed = await observeNativeWindowsIPv4(saved, 15000, deps);
			return observed.original || observed.target ? 'completed' : 'interrupted';
		}
	);
	assert.equal(result.state, 'completed');
}

try {
	const original = await read();
	const originalOracle = oracle();
	assert.equal(
		original.dns.every(policy => policy.automatic),
		true
	);
	assert.equal(original.stores.ActiveStore.routes.length, 0);
	await apply(['192.0.2.53', '2001:db8::53']);
	assert.deepEqual(oracle().dns, [
		{ family: 2, servers: ['192.0.2.53'] },
		{ family: 23, servers: ['2001:db8::53'] },
	]);
	console.log('Native CIM DNS write verified by independent cmdlets');
	await apply([]);
	assert.equal(windowsIPv4Fingerprint(await read()), windowsIPv4Fingerprint(original));
	assert.deepEqual(oracle(), originalOracle);
	console.log('Native CIM DNS automatic policy reset verified');
	let refused = false;
	let successfulWrites = 0;
	await assert.rejects(
		apply(['198.51.100.53', '2001:db8::54'], {
			...deps,
			write: async request => {
				if (!refused && request.step.kind === 'dns' && request.step.policy.family === 23) {
					assert.equal(successfulWrites, 1);
					assert.deepEqual(oracle().dns.find(policy => policy.family === 2)?.servers, ['198.51.100.53']);
					refused = true;
					return { sent: false, error: 'Injected second-family pre-dispatch refusal' };
				}
				const result: WindowsIPv4WriteResult = await deps.write(request);
				if (result.sent && 'result' in result && result.result.outcome === 'ok') successfulWrites++;
				return result;
			},
		}),
		/Injected second-family pre-dispatch refusal/
	);
	assert.equal(refused, true);
	assert.equal(successfulWrites, 3);
	assert.equal(windowsIPv4Fingerprint(await read()), windowsIPv4Fingerprint(original));
	assert.deepEqual(oracle(), originalOracle);
	assert.equal(await host.state('network'), undefined);
	console.log(JSON.stringify({ platform: process.platform, arch: process.arch, bun: Bun.version, dnsWrite: true, dnsReset: true, partialWriteRollback: true, journalSettled: true }));
} finally {
	reader.close();
	writer.close();
	assert.equal(await host.closeAndDrain(), true);
	await Promise.all([reader.waitUntilClosed(), writer.waitUntilClosed()]);
	await rm(directory, { recursive: true, force: true });
}
