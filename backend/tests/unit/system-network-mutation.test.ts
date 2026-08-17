import { describe, expect, it } from 'bun:test';
import { ipv4EditObjection, networkStateGeneration, resetNetworkStateCache, runHostMutation } from '../../src/system-network.ts';
import { ErrorCodes, type NetInterfaceInfo, type NetworkStateInfo } from '@shared';

/**
 * A host reconfiguration is several platform commands and is not atomic, while
 * the state poll reads the machine on its own schedule. These cover the two
 * halves that keep the two from publishing fiction at each other: the cache is
 * invalidated on BOTH sides of the platform action, and the state the machine
 * was actually left in is read and broadcast whatever the outcome was.
 */
describe('runHostMutation', () => {
	it('invalidates the cache before the platform action runs', async () => {
		// The leading invalidation is what discards a read that starts mid-apply.
		// Without it that read carries the pre-apply generation, is accepted when it
		// finishes, and publishes an intermediate state as the truth.
		const before = networkStateGeneration();
		let duringAction = -1;
		await runHostMutation(async () => {
			duringAction = networkStateGeneration();
		});
		expect(duringAction).toBeGreaterThan(before);
	});

	it('invalidates the cache again after the action fails', async () => {
		let duringAction = -1;
		await expect(
			runHostMutation(async () => {
				duringAction = networkStateGeneration();
				throw new Error('the route could not be rewritten');
			})
		).rejects.toThrow('the route could not be rewritten');
		// A failed apply is exactly when the cached reading is fiction: the error
		// says the request did not complete, not that nothing changed.
		expect(networkStateGeneration()).toBeGreaterThan(duringAction);
	});

	it('invalidates the cache again after the action succeeds', async () => {
		let duringAction = -1;
		await runHostMutation(async () => {
			duringAction = networkStateGeneration();
		});
		expect(networkStateGeneration()).toBeGreaterThan(duringAction);
	});

	it('serializes two mutations rather than interleaving their steps', async () => {
		const order: string[] = [];
		const slow = runHostMutation(async () => {
			order.push('a:start');
			await new Promise(resolve => setTimeout(resolve, 20));
			order.push('a:end');
		});
		const fast = runHostMutation(async () => {
			order.push('b:start');
		});
		await Promise.all([slow, fast]);
		expect(order).toEqual(['a:start', 'a:end', 'b:start']);
		resetNetworkStateCache();
	});
});

/**
 * The apply's own re-check of the conditions the settings screen also checks.
 *
 * The frontend gates the Configure button on all three, but it is not the
 * security boundary: a direct RPC client sends none of them, and a frontend
 * acting on a snapshot a few seconds old sends them as they WERE. The apply is
 * destructive from a wrong premise — on Windows it removes every IPv4 address
 * and default route before creating the single new one — so the premise is
 * re-established inside the mutation lock, against freshly-read state.
 */
describe('ipv4EditObjection', () => {
	const iface = (overrides: Partial<NetInterfaceInfo> = {}): NetInterfaceInfo => ({
		id: 'eth0',
		name: 'eth0',
		medium: 'wired',
		link: 'up',
		defaultRoute: true,
		mac: null,
		addresses: [{ family: 'ipv4', address: '192.0.2.10', prefixLength: 24 }],
		ipv4Mode: 'static',
		gateway: '192.0.2.1',
		dns: [],
		ipv4Configurable: true,
		wifiScannable: false,
		wifiConnectable: false,
		...overrides,
	});
	const state = (overrides: Partial<NetworkStateInfo> = {}): NetworkStateInfo => ({
		interfaces: [iface()],
		primaryID: 'eth0',
		detail: 'full',
		known: true,
		capabilities: { ipv4: true, wifi: false, staticGatewayRequired: false },
		...overrides,
	});

	it('raises no objection to a settled, reachable, single-address interface', () => {
		expect(ipv4EditObjection(state(), 'eth0')).toBeNull();
	});

	it('refuses an apply built on an address-only reading', () => {
		// That fallback reports runtime device names where the apply resolves adapter
		// GUIDs, and cannot say whether an address came from DHCP.
		expect(ipv4EditObjection(state({ detail: 'addressesOnly' }), 'eth0')?.code).toBe(ErrorCodes.NETCONFIG_UNSUPPORTED);
	});

	it('refuses an interface that is no longer there', () => {
		expect(ipv4EditObjection(state(), 'eth9')?.code).toBe(ErrorCodes.NETCONFIG_INVALID);
	});

	it('refuses an interface the tooling cannot reach', () => {
		expect(ipv4EditObjection(state({ interfaces: [iface({ ipv4Configurable: false })] }), 'eth0')?.code).toBe(ErrorCodes.NETCONFIG_UNSUPPORTED);
	});

	// The aliases the UI was protecting are exactly what a Windows apply destroys:
	// it removes every IPv4 address before creating the one the form holds.
	it('refuses an interface carrying several IPv4 addresses', () => {
		const aliased = iface({
			addresses: [
				{ family: 'ipv4', address: '192.0.2.10', prefixLength: 24 },
				{ family: 'ipv4', address: '192.0.2.11', prefixLength: 24 },
			],
		});
		expect(ipv4EditObjection(state({ interfaces: [aliased] }), 'eth0')?.code).toBe(ErrorCodes.NETCONFIG_UNSUPPORTED);
	});

	it('counts only IPv4 — an interface with IPv6 alongside is still editable', () => {
		const dual = iface({
			addresses: [
				{ family: 'ipv4', address: '192.0.2.10', prefixLength: 24 },
				{ family: 'ipv6', address: '2001:db8::1', prefixLength: 64 },
				{ family: 'ipv6', address: 'fe80::1', prefixLength: 64 },
			],
		});
		expect(ipv4EditObjection(state({ interfaces: [dual] }), 'eth0')).toBeNull();
	});
});
