import { expect, it } from 'bun:test';
import { resolve } from 'node:path';

/**
 * A Linux read whose NetworkManager profiles could not be read says so in the network state,
 * so the settings screen can explain why IPv4 editing is off instead of just hiding it. Runs
 * the real `readNetworkState` in its own process with only the Linux reader replaced.
 */
function readFlag(unavailable: boolean): unknown {
	const script = `
		import { mock } from 'bun:test';
		const platform = await import('./src/system-network-linux.ts');
		const iface = { id: 'eth0', name: 'eth0', medium: 'wired', link: 'up', defaultRoute: true, mac: null, addresses: [], ipv4Mode: 'unknown', ipv4Configurable: false, wifiConfigurable: false, gateway: null, dns: [] };
		mock.module('./src/system-network-linux.ts', () => ({
			...platform,
			readLinuxCapabilities: async () => ({ ipv4: true, wifi: false, staticGatewayRequired: false }),
			readLinuxNetworkState: async () => ({ interfaces: [iface], ipv4ProfilesUnavailable: ${unavailable} }),
		}));
		Object.defineProperty(process, 'platform', { value: 'linux' });
		const { readNetworkState } = await import('./src/system-network.ts');
		const state = await readNetworkState();
		process.stdout.write('RESULT:' + JSON.stringify({ flag: state.ipv4ProfilesUnavailable }) + '\\n');
	`;
	const result = Bun.spawnSync([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), timeout: 10_000 });
	expect(result.stderr.toString()).toBe('');
	const line = result.stdout
		.toString()
		.split(/\r?\n/)
		.find(l => l.startsWith('RESULT:'));
	expect(line).toBeDefined();
	return JSON.parse(line!.slice('RESULT:'.length)).flag;
}

it('reports unreadable NetworkManager profiles in the network state', () => {
	expect(readFlag(true)).toBe(true);
	expect(readFlag(false)).toBe(false);
});
