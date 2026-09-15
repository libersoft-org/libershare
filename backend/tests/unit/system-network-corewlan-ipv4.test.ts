import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

interface ApplyResult {
	guards: number;
	direct: number;
	elevated: number;
	code?: string;
	detail?: string;
}

/** Exercise the IPv4 dispatcher without allowing native commands or elevation in the subprocess. */
function attempt(busy: boolean, elevation: boolean): ApplyResult {
	const script = `
		import { mock } from 'bun:test';
		import { ipv4BaselineOf } from '@shared';
		const platform = await import('./src/system-network-macos.ts');
		const corewlan = await import('./src/system-network-corewlan.ts');
		const helper = await import('./src/network-helper-client.ts');
		let guards = 0, direct = 0, elevated = 0;
		const iface = {
			id: 'en0', name: 'Wi-Fi', medium: 'wireless', link: 'up', defaultRoute: true,
			mac: null, addresses: [{ family: 'ipv4', address: '192.0.2.10', prefixLength: 24 }],
			ipv4Mode: 'static', ipv4Configurable: true, wifiConfigurable: true,
			gateway: '192.0.2.1', dns: ['192.0.2.53']
		};
		mock.module('./src/system-network-macos.ts', () => ({
			...platform,
			isMacWritable: async () => ${!elevation},
			isMacWifiConfigurable: async () => true,
			readMacNetworkState: async () => [iface],
			applyMacIPv4: async () => { direct++; throw new Error('direct mutation reached'); }
		}));
		mock.module('./src/system-network-corewlan.ts', () => ({
			...corewlan,
			assertMacWifiMutationIdle: () => {
				guards++;
				if (${busy}) throw new Error('native association still running');
			}
		}));
		mock.module('./src/network-helper-client.ts', () => ({
			...helper,
			networkHelperAvailable: async () => true,
			runElevatedNetworkHelper: async () => { elevated++; throw new Error('elevated mutation reached'); }
		}));
		Object.defineProperty(process, 'platform', { value: 'darwin' });
		const { applyIPv4Unlocked } = await import('./src/system-network.ts');
		let failure;
		try {
			await applyIPv4Unlocked('en0', { mode: 'static', address: '192.0.2.20', prefixLength: 24, gateway: '192.0.2.1' }, '', true, ipv4BaselineOf(iface));
		} catch (error) { failure = { code: error.code, detail: error.detail }; }
		process.stdout.write('RESULT:' + JSON.stringify({ guards, direct, elevated, ...failure }) + '\\n');
	`;
	const child = Bun.spawnSync([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), timeout: 10_000 });
	expect(child.exitCode).toBe(0);
	expect(child.stderr.toString()).toBe('');
	const output = child.stdout.toString().split(/\r?\n/).find(line => line.startsWith('RESULT:'));
	expect(output).toBeDefined();
	return JSON.parse(output!.slice('RESULT:'.length));
}

for (const elevation of [false, true]) {
	describe(`IPv4 apply with elevation=${elevation} during a native Wi-Fi association`, () => {
		it('rejects the apply before either native mutation or elevation starts', () => {
			expect(attempt(true, elevation)).toEqual({ guards: 1, direct: 0, elevated: 0, code: 'NETCONFIG_FAILED', detail: 'native association still running' });
		});

		it('reaches the selected mutation when the native Wi-Fi worker is idle', () => {
			expect(attempt(false, elevation)).toEqual({ guards: 1, direct: elevation ? 0 : 1, elevated: elevation ? 1 : 0, code: 'NETCONFIG_FAILED', detail: elevation ? 'elevated mutation reached' : 'direct mutation reached' });
		});
	});
}
