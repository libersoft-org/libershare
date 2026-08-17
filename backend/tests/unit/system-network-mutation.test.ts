import { describe, expect, it } from 'bun:test';
import { applyIPv4, connectWifi, ipv4EditObjection, networkStateGeneration, readNetworkStateUnlocked, readSettledNetworkState, resetNetworkStateCache, runHostMutation, withVolatileCapabilities } from '../../src/system-network.ts';
import { windowsIPv4Objection } from '../../src/system-network-windows.ts';
import { CodedError, ErrorCodes, validateIPv4Config, type NetInterfaceInfo, type NetIPv4Config, type NetworkStateInfo } from '@shared';

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

	// The half the poll-tick skip did not cover. A direct `system.network` request
	// never consulted the lock: it went through the ordinary cached read, and a
	// Windows Wi-Fi join holds the lock for far longer than the 5 s cache lives —
	// so the cache expired mid-join and the next request read the machine between
	// the old configuration going and the new one arriving.
	it('makes a direct read wait for a reconfiguration instead of reading through it', async () => {
		let answered = false;
		let stillWaiting = false;
		let request: Promise<unknown> = Promise.resolve();
		await runHostMutation(async () => {
			// Issued from inside the mutation, which is where the lock is held — the
			// position an RPC request arriving mid-apply is in.
			request = readSettledNetworkState().then(() => {
				answered = true;
			});
			// A whole platform read, taken the way a mutation is allowed to take one.
			// Its completing HERE is what makes the assertion below about the lock
			// rather than about the clock: the request outside has had at least as long
			// as a read costs, and has still not been served.
			await readNetworkStateUnlocked();
			// And a further pause, because the two reads share one in-flight platform
			// call: without the lock they would settle within microtasks of each other,
			// which is a difference too small to assert on.
			await new Promise(resolve => setTimeout(resolve, 200));
			stillWaiting = !answered;
		});
		await request;
		expect(stillWaiting).toBe(true);
		expect(answered).toBe(true);
		resetNetworkStateCache();
	});

	// The mutation's own premise read cannot wait for the lock its caller holds, so
	// the two reads are deliberately different functions — and the settled one must
	// never be the one a mutation reaches for.
	it('keeps a mutation off the lock-taking read, which would deadlock it', () => {
		expect(applyIPv4.toString()).toContain('readNetworkStateUnlocked');
		for (const body of [applyIPv4.toString(), connectWifi.toString()]) expect(body).not.toContain('readSettledNetworkState');
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
 * The half of the capability probe that must not be remembered.
 *
 * The probe is cached for the whole process, which is right for an elevated
 * token and for `admin` group membership — neither can change without a new
 * process — and wrong for the Windows radio: a USB adapter plugged in after
 * start, or WLAN AutoConfig restarted, left the entire Wi-Fi section hidden
 * until the app was restarted.
 */
describe('withVolatileCapabilities', () => {
	const remembered = { ipv4: true, wifi: false, staticGatewayRequired: false } as const;

	it('re-asks the windows radio question every time', () => {
		expect(withVolatileCapabilities(remembered, 'win32', () => true).wifi).toBe(true);
		expect(withVolatileCapabilities({ ...remembered, wifi: true }, 'win32', () => false).wifi).toBe(false);
	});

	it('leaves the rest of the remembered probe alone', () => {
		const fresh = withVolatileCapabilities(remembered, 'win32', () => true);
		expect(fresh.ipv4).toBe(true);
		expect(fresh.staticGatewayRequired).toBe(false);
	});

	it('does not re-probe where the answer costs a spawn and cannot change', () => {
		// Linux pays an nmcli spawn for this answer and a 5 s read cadence must not
		// pay it again; macOS reports a constant.
		for (const platform of ['linux', 'darwin', 'freebsd']) {
			expect(
				withVolatileCapabilities(remembered, platform, () => {
					throw new Error('probed anyway');
				})
			).toBe(remembered);
		}
	});
});

/**
 * The combination the shared validator accepts and Windows cannot express.
 *
 * `validateIPv4Config` waives the on-link gateway check at `/32` on purpose — a
 * host route has no subnet, so an off-link gateway is the normal arrangement —
 * while `New-NetIPAddress -DefaultGateway` requires the gateway to be inside the
 * address's own subnet. Discovered by the apply, that refusal arrives after the
 * old addresses and routes have already been removed.
 */
describe('windowsIPv4Objection', () => {
	const slash32 = { mode: 'static', address: '192.0.2.10', prefixLength: 32, gateway: '198.51.100.1' } as NetIPv4Config;

	it('refuses a gateway on an address with no subnet', () => {
		// The shared validator is right to accept it, and Windows still cannot do it.
		expect(validateIPv4Config(slash32)).toBeNull();
		expect(windowsIPv4Objection(slash32)).toContain('/32');
	});

	it('says nothing about a /32 with no gateway, which Windows can set', () => {
		expect(windowsIPv4Objection({ mode: 'static', address: '192.0.2.10', prefixLength: 32 })).toBeNull();
	});

	it('says nothing about the ordinary prefixes, /31 included', () => {
		for (const prefixLength of [24, 30, 31]) expect(windowsIPv4Objection({ mode: 'static', address: '192.0.2.0', prefixLength, gateway: '192.0.2.1' })).toBeNull();
	});

	it('says nothing about a DHCP config', () => {
		expect(windowsIPv4Objection({ mode: 'dhcp' })).toBeNull();
	});

	// Refused before the mutation lock is taken, so nothing has been removed by the
	// time the user is told no. Only meaningful on Windows, which is where the
	// apply would otherwise reach New-NetIPAddress.
	it.skipIf(process.platform !== 'win32')('refuses the apply before it can remove anything', async () => {
		const error = (await applyIPv4('{2B1F0E8A-4C3D-4E5F-9A7B-1C2D3E4F5A6B}', slash32).catch((err: unknown) => err)) as CodedError;
		expect(error).toBeInstanceOf(CodedError);
		expect(error.code).toBe(ErrorCodes.NETCONFIG_UNSUPPORTED);
		expect(error.message).toContain('/32');
	});
});

/**
 * Where the join's premise is established.
 *
 * Both conditions a join rests on — this interface can be driven over Wi-Fi, and
 * it is not already on that network — come from {@link readNetworkStateUnlocked}, which
 * serves a reading up to CACHE_TTL_MS old. Checked BEFORE the lock, that reading
 * predates both the cache invalidation and any mutation queued ahead of this one,
 * so it can approve a join against a state the machine has already left. Checked
 * inside, it is the same state the join then acts on.
 *
 * Telling the two apart at runtime needs a real wireless adapter driven into a
 * chosen association state, which no unit test has — the ordering is therefore
 * asserted on the compiled function body, where it is exactly as visible.
 */
describe('connectWifi', () => {
	const body = connectWifi.toString();

	it('mentions each step of the guard it is ordering', () => {
		// Without this an identifier that got renamed would leave the assertions
		// below comparing -1 against -1 and passing on a function that guards nothing.
		for (const step of ['runHostMutation', 'assertWirelessInterface', 'isAlreadyJoined']) expect(body).toContain(step);
	});

	it('re-reads the interface inside the lock rather than before it', () => {
		expect(body.indexOf('assertWirelessInterface')).toBeGreaterThan(body.indexOf('runHostMutation'));
	});

	it('refuses the network already in use from inside the lock as well', () => {
		expect(body.indexOf('isAlreadyJoined')).toBeGreaterThan(body.indexOf('runHostMutation'));
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
