import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

interface Scenario {
	security: string;
	password: string;
	expectedSecurity?: unknown;
	rpc?: boolean;
}

/** Isolate platform mocks from other tests and count writes through the real join dispatcher. */
function attempt(scenario: Scenario): { mutations: number; scans: number; code?: string; detail?: string } {
	const script = `
		import { mock } from 'bun:test';
		const input = ${JSON.stringify(scenario)};
		const platform = await import('./src/system-network-linux.ts');
		let mutations = 0;
		let scans = 0;
		const iface = { id: 'wlan0', name: 'Wi-Fi', medium: 'wireless', link: 'down', defaultRoute: false, mac: null, addresses: [], ipv4Mode: 'dhcp', ipv4Configurable: true, wifiConfigurable: true, gateway: null, dns: [] };
		mock.module('./src/system-network-linux.ts', () => ({
			...platform,
			readLinuxCapabilities: async () => ({ ipv4: true, wifi: true, staticGatewayRequired: false }),
			readLinuxNetworkState: async () => [iface],
			scanLinuxWifi: async () => {
				scans++;
				return [{ ssid: 'Example', bssid: null, signal: 70, security: input.security, secured: input.security !== '', supported: true, active: false }];
			},
			connectLinuxWifi: async () => { mutations++; },
		}));
		Object.defineProperty(process, 'platform', { value: 'linux' });
		const { connectWifi } = await import('./src/system-network.ts');
		let failure;
		try {
			if (input.rpc) {
				const { initSystemHandlers } = await import('./src/api/system.ts');
				const handlers = initSystemHandlers({ get: () => '' }, () => {}, () => false, true);
				await handlers.wifiConnect({ interfaceID: 'wlan0', ssid: 'Example', password: input.password, expectedSecurity: input.expectedSecurity });
			} else {
				await connectWifi('wlan0', 'Example', input.password, '', null, input.expectedSecurity);
			}
		} catch (error) { failure = { code: error.code, detail: error.detail }; }
		process.stdout.write('RESULT:' + JSON.stringify({ mutations, scans, ...failure }) + '\\n');
	`;
	const result = Bun.spawnSync([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), timeout: 10_000 });
	expect(result.exitCode).toBe(0);
	expect(result.stderr.toString()).toBe('');
	const output = result.stdout.toString().split(/\r?\n/).find(line => line.startsWith('RESULT:'));
	expect(output).toBeDefined();
	return JSON.parse(output!.slice('RESULT:'.length));
}

describe('Wi-Fi security selection across a fresh scan', () => {
	it.each(['', 'WPA3'])('refuses a selected WPA2 network that now advertises %s before any platform mutation', security => {
		const result = attempt({ security, password: 'example-password', expectedSecurity: 'WPA2' });
		expect(result).toMatchObject({ mutations: 0, scans: 1, code: 'NETCONFIG_INVALID' });
		expect(result.detail).toContain('security changed');
	});

	it('forwards expectedSecurity through the RPC handler before platform mutation', () => {
		const result = attempt({ security: '', password: 'example-password', expectedSecurity: 'WPA2', rpc: true });
		expect(result).toMatchObject({ mutations: 0, scans: 1, code: 'NETCONFIG_INVALID' });
		expect(result.detail).toContain('security changed');
	});

	it('refuses an unexpected open network even when the client omits expectedSecurity', () => {
		const result = attempt({ security: '', password: 'example-password', rpc: true });
		expect(result).toMatchObject({ mutations: 0, scans: 1, code: 'NETCONFIG_INVALID' });
		expect(result.detail).toContain('without a password');
	});

	it.each([
		{ security: 'WPA2', password: 'example-password', expectedSecurity: 'WPA2' },
		{ security: '', password: '', expectedSecurity: '' },
		{ security: 'WPA2', password: 'example-password' },
		{ security: '', password: '' },
	])('allows matching and legacy requests: %j', scenario => {
		expect(attempt(scenario)).toEqual({ mutations: 1, scans: 1 });
	});

	it.each([null, 3, {}, [], 'x'.repeat(65), 'WPA2\0', 'WPA2\n'].map(expectedSecurity => ({ expectedSecurity })))('rejects malformed expectedSecurity %j before scanning or mutation', ({ expectedSecurity }) => {
		const result = attempt({ security: 'WPA2', password: 'example-password', expectedSecurity });
		expect(result).toMatchObject({ mutations: 0, scans: 0, code: 'NETCONFIG_INVALID' });
		expect(result.detail).toContain('invalid expected');
	});
});
