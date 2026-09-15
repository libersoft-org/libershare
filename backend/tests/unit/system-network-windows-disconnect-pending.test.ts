import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

type Outcome = 'timeout' | 'query-error' | 'refused' | 'early-query-error' | 'success' | 'already-idle';

/** Keep the real disconnect/guard module while replacing every WLAN access in an isolated process. */
function scenario(outcome: Outcome): any {
	const script = `
		import { mock } from 'bun:test';
		const native = await import('./src/system-network-windows-wlan.ts');
		const outcome = ${JSON.stringify(outcome)};
		const guid = '{11111111-2222-3333-4444-555555555555}';
		let accepted = false, recovered = false, disconnects = 0, scans = 0, lookups = 0, profileWrites = 0;
		let forcedState;
		function state() {
			if (forcedState !== undefined) return forcedState;
			if (recovered || outcome === 'already-idle' || (outcome === 'success' && accepted)) return 4;
			if (outcome === 'early-query-error' || (outcome === 'query-error' && accepted)) throw new Error('query failed');
			return 1;
		}
		const api = {
			WlanDisconnect: () => { disconnects++; if (outcome === 'refused') return 5; accepted = true; return 0; },
			WlanScan: () => { scans++; throw new Error('scan reached'); },
			WlanGetAvailableNetworkList: () => { lookups++; throw new Error('join lookup reached'); },
			WlanSetProfile: () => { profileWrites++; throw new Error('unexpected profile write'); },
		};
		mock.module('./src/system-network-windows-wlan.ts', () => ({ ...native,
			withWlanHandle: action => action(api, 1n),
			isWindowsWifiDisconnected: () => state() === 4,
			readWindowsWifiOperationState: () => ({ state: state(), profileName: 'Example', ssidHex: '4578616D706C65' }),
		}));
		let ticks = 0; Date.now = () => ++ticks * 10001;
		const timer = setTimeout; globalThis.setTimeout = (fn, delay, ...args) => timer(fn, delay === 500 ? 0 : delay, ...args);
		const wifi = await import('./src/system-network-windows-wifi.ts');
		let failure = null;
		try { await wifi.disconnectWindowsWifi(guid); } catch (error) { failure = error.message; }
		let blocked = false; try { wifi.assertWindowsWifiMutationIdle(); } catch { blocked = true; }
		const windows = await import('./src/system-network-windows.ts');
		const helper = await import('./src/network-helper-client.ts');
		const environment = await import('./src/network-helper-windows.ts');
		const childProcess = await import('node:child_process');
		const { promisify } = await import('node:util');
		const { ipv4BaselineOf } = await import('@shared');
		let elevatedMode = false, directWrites = 0, elevatedWrites = 0;
		const iface = {
			id: guid, name: 'Wi-Fi', medium: 'wireless', link: 'up', defaultRoute: true,
			mac: null, addresses: [{ family: 'ipv4', address: '192.0.2.10', prefixLength: 24 }],
			ipv4Mode: 'static', ipv4Configurable: true, wifiConfigurable: true,
			gateway: '192.0.2.1', dns: ['192.0.2.53']
		};
		const execFile = () => {};
		execFile[promisify.custom] = async (_file, args) => {
			if (args.includes(windows.WINDOWS_ELEVATION_COMMAND)) return { stdout: String(!elevatedMode) };
			if (args.includes(windows.WINDOWS_STATE_COMMAND)) return { stdout: 'state fixture' };
			directWrites++; throw new Error('direct IPv4 reached');
		};
		mock.module('node:child_process', () => ({ ...childProcess, execFile }));
		mock.module('./src/system-network-windows.ts', () => ({ ...windows,
			parseWindowsNetworkState: () => [iface], readWindowsWifi: () => new Map(), isWindowsWifiConfigurable: () => true,
		}));
		mock.module('./src/network-helper-client.ts', () => ({ ...helper,
			networkHelperAvailable: async () => true,
			runElevatedNetworkHelper: async () => { elevatedWrites++; throw new Error('elevated IPv4 reached'); },
		}));
		mock.module('./src/network-helper-windows.ts', () => ({ ...environment,
			windowsPowerShellPath: () => 'powershell.exe', windowsSystemEnvironment: () => ({}),
		}));
		Object.defineProperty(process, 'platform', { value: 'win32' });
		const common = await import('./src/system-network.ts');
		async function ipv4(elevated) {
			elevatedMode = elevated;
			common.resetNetworkCapabilitiesCache();
			return common.applyIPv4Unlocked(guid, { mode: 'static', address: '192.0.2.20', prefixLength: 24, gateway: '192.0.2.1' }, '', true, ipv4BaselineOf(iface));
		}
		const before = { disconnects, scans, lookups, profileWrites };
		const conflicts = [];
		if (outcome === 'timeout' || outcome === 'query-error') {
			for (const action of [
				() => wifi.scanWindowsWifi(guid),
				() => wifi.connectWindowsWifi(guid, 'Example', 'example-password', 'WPA2', '4578616D706C65'),
				() => wifi.disconnectWindowsWifi(guid),
				() => common.scanWifi(guid),
				() => common.connectWifi(guid, 'Example', 'example-password'),
				() => common.disconnectWifi(guid),
				() => ipv4(false), () => ipv4(true),
			]) {
				try { await action(); conflicts.push(null); } catch (error) { conflicts.push(error.message); }
			}
		}
		const after = { disconnects, scans, lookups, profileWrites };
		const ipv4BeforeRecovery = { directWrites, elevatedWrites };
		const nonDisconnectedBlocked = [];
		if (outcome === 'timeout' || outcome === 'query-error') {
			for (forcedState of [0, 1, 2, 3, 5, 6, 7]) {
				try { wifi.assertWindowsWifiMutationIdle(); nonDisconnectedBlocked.push(false); } catch { nonDisconnectedBlocked.push(true); }
			}
			forcedState = undefined;
		}
		recovered = true;
		let recoveryBlocked = false; try { wifi.assertWindowsWifiMutationIdle(); } catch { recoveryBlocked = true; }
		try { await wifi.scanWindowsWifi(guid); } catch {}
		const recoveredIPv4 = [];
		for (const elevated of [false, true]) {
			try { await ipv4(elevated); recoveredIPv4.push(null); } catch (error) { recoveredIPv4.push(error.detail ?? error.message); }
		}
		console.log('RESULT:' + JSON.stringify({ failure, blocked, before, after, conflicts, recoveryBlocked, scansAfterRecovery: scans, disconnects, profileWrites, ipv4BeforeRecovery, recoveredIPv4, directWrites, elevatedWrites, nonDisconnectedBlocked }));
	`;
	const child = Bun.spawnSync([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), timeout: 10_000 });
	expect(child.exitCode).toBe(0);
	expect(child.stderr.toString()).toBe('');
	const output = child.stdout.toString().split(/\r?\n/).find(line => line.startsWith('RESULT:'));
	expect(output).toBeDefined();
	return JSON.parse(output!.slice(7));
}

describe('Windows standalone disconnect quarantine', () => {
	it.each(['timeout', 'query-error'] as const)('blocks later native work after an accepted disconnect ends with %s', outcome => {
		const result = scenario(outcome);
		expect(result.blocked).toBe(true);
		expect(result.failure).toContain('unknown result');
		expect(result.conflicts).toHaveLength(8);
		expect(result.conflicts.every((error: string) => error.includes('unknown result'))).toBe(true);
		expect(result.after).toEqual(result.before);
		expect(result.ipv4BeforeRecovery).toEqual({ directWrites: 0, elevatedWrites: 0 });
		expect(result.nonDisconnectedBlocked).toEqual([true, true, true, true, true, true, true]);
		expect(result.recoveryBlocked).toBe(false);
		expect(result.scansAfterRecovery).toBe(result.before.scans + 1);
		expect(result.disconnects).toBe(1);
		expect(result.profileWrites).toBe(0);
		expect(result.recoveredIPv4).toEqual(['direct IPv4 reached', 'elevated IPv4 reached']);
		expect(result.directWrites).toBe(1);
		expect(result.elevatedWrites).toBe(1);
	});

	it.each(['refused', 'early-query-error', 'success', 'already-idle'] as const)('does not leave a pending operation after %s', outcome => {
		const result = scenario(outcome);
		expect(result.blocked).toBe(false);
		expect(result.before.disconnects).toBe(outcome === 'early-query-error' || outcome === 'already-idle' ? 0 : 1);
		expect(result.profileWrites).toBe(0);
		if (outcome === 'success' || outcome === 'already-idle') expect(result.failure).toBeNull();
		else expect(result.failure).toEqual(expect.any(String));
	});
});
