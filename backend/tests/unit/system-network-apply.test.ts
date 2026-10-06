import { afterEach, describe, expect, it } from 'bun:test';
import { canonicalDnsServer, ErrorCodes, ipv4BaselineOf, isIPv4, isIPv6, isUnambiguousWifiTarget, isValidSSID, isValidWifiKey, isWifiHexKey, MAX_DNS_SERVERS, normalizeDnsServers, validateIPv4Config, type NetInterfaceInfo, type NetIPv4Config, type NetWifiNetwork, type NetworkStateInfo } from '@shared';
import { NETWORK_MANAGER_CHECKPOINT_SAFETY_MS, NETWORK_MANAGER_CHECKPOINT_TIMEOUT_SECONDS, NETWORK_MANAGER_IPV4_TRANSACTION_TIMEOUT_MS, NETWORK_MANAGER_MUTATION_TIMEOUT_MS, NETWORK_MANAGER_PROFILE_UPDATE_TIMEOUT_MS, NETWORK_MANAGER_ROLLBACK_TIMEOUT_MS, NETWORK_MANAGER_WIFI_TRANSACTION_TIMEOUT_MS, parseNmcliIPv4Method } from '../../src/system-network-linux.ts';
import { splitNmcliFields, parseNmcliWifiList, parseNmcliIPv4Profile } from '../helpers/linux-network-oracle.ts';
import { isWindowsInterfaceID } from '../../src/system-network-windows.ts';
import { assertAppliedIPv4State, assertDeviceName, assertIPv4Baseline, CAPABILITY_NEGATIVE_TTL_MS, CAPABILITY_POSITIVE_TTL_MS, firstLine, isIPv4AddressingUnchanged, isIPv4ConfigUnchanged, isValidWifiPassword, leaseRequired, MAX_WIFI_PASSWORD_BYTES, planIPv4Change, readCachedCapabilities, resetNetworkCapabilitiesCache, resolveJoinTarget, runNetworkMutation } from '../../src/system-network.ts';

describe('isIPv4', () => {
	it('accepts ordinary dotted quads', () => {
		for (const value of ['192.0.2.1', '0.0.0.0', '255.255.255.255', '198.51.100.42']) expect(isIPv4(value)).toBe(true);
	});

	it('rejects anything that is not four plain octets', () => {
		for (const value of ['192.0.2', '192.0.2.1.5', '192.0.2.256', '192.0.2.-1', '192.0.2.a', '', ' 192.0.2.1']) expect(isIPv4(value)).toBe(false);
	});

	it('rejects leading zeros, which some resolvers read as octal', () => {
		expect(isIPv4('192.0.2.01')).toBe(false);
		expect(isIPv4('010.0.0.1')).toBe(false);
	});
});

describe('isIPv6', () => {
	it('accepts compressed, expanded and IPv4-mapped literals', () => {
		for (const value of ['::1', '2001:db8::53', 'fe90::1', '2001:0db8:0000:0000:0000:0000:0000:0053', '::ffff:192.0.2.1']) expect(isIPv6(value)).toBe(true);
	});

	it('rejects malformed values and scope suffixes', () => {
		for (const value of ['', ':', '2001:::1', '2001:db8::1::2', 'gggg::1', 'fe80::1%12']) expect(isIPv6(value)).toBe(false);
	});

	it('rejects trailing URL syntax and PowerShell metacharacters', () => {
		for (const value of ["::1]/';Stop-Computer;#", '::1]/path', '::1]?query', '::1]@host']) expect(isIPv6(value)).toBe(false);
		expect(validateIPv4Config({ mode: 'dhcp', dns: ["::1]/';Stop-Computer;#"] })).toBe('dns');
	});
});

describe('validateIPv4Config', () => {
	it('accepts a DHCP config with nothing else set', () => {
		expect(validateIPv4Config({ mode: 'dhcp' })).toBeNull();
	});

	it('accepts a complete static config', () => {
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.1', '2001:db8::53', '127.0.0.1'] })).toBeNull();
	});

	it('accepts a static config with no gateway, as on an isolated segment', () => {
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 24 })).toBeNull();
	});

	it('requires a static gateway when the platform tool does', () => {
		const capabilities = { staticGatewayRequired: true };
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 24 }, capabilities)).toBe('gateway');
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1' }, capabilities)).toBeNull();
	});

	it('names the field that is wrong', () => {
		expect(validateIPv4Config({ mode: 'static', prefixLength: 24 })).toBe('address');
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 0 })).toBe('prefixLength');
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 33 })).toBe('prefixLength');
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: 'nope' })).toBe('gateway');
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 24, dns: ['192.0.2.1', 'nope'] })).toBe('dns');
		expect(validateIPv4Config({ mode: 'bogus' } as unknown as NetIPv4Config)).toBe('mode');
	});

	it('rejects a DNS list even when the mode is DHCP', () => {
		// The servers are still applied in DHCP mode on some stacks, so they cannot
		// be waved through just because the address is not being set.
		expect(validateIPv4Config({ mode: 'dhcp', dns: ['not an address'] })).toBe('dns');
	});

	it('refuses anything carrying shell or PowerShell syntax', () => {
		for (const attack of ["192.0.2.1'; Stop-Computer; '", '192.0.2.1 -and $(calc)', '$(whoami)', '192.0.2.1;reboot']) {
			expect(validateIPv4Config({ mode: 'static', address: attack, prefixLength: 24 })).toBe('address');
			expect(validateIPv4Config({ mode: 'static', address: '192.0.2.1', prefixLength: 24, gateway: attack })).toBe('gateway');
		}
	});

	it('rejects addresses that cannot identify a normal interface host', () => {
		for (const address of ['0.0.0.0', '127.0.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255', '192.0.2.0', '192.0.2.255']) {
			expect(validateIPv4Config({ mode: 'static', address, prefixLength: 24, gateway: '192.0.2.1' })).toBe('address');
		}
	});

	it('requires a distinct on-link unicast gateway', () => {
		for (const gateway of ['0.0.0.0', '127.0.0.1', '224.0.0.1', '192.0.2.0', '192.0.2.255', '192.0.2.10', '198.51.100.1']) {
			expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway })).toBe('gateway');
		}
	});

	it('handles point-to-point and host prefixes explicitly', () => {
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 31, gateway: '192.0.2.11' })).toBeNull();
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 32 })).toBeNull();
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 32, gateway: '192.0.2.11' })).toBe('gateway');
	});

	it('bounds and deduplicates resolver lists without rejecting loopback DNS', () => {
		expect(normalizeDnsServers(['127.0.0.1', '2001:DB8::53', '127.0.0.1', '2001:db8::53'])).toEqual(['127.0.0.1', '2001:db8::53']);
		expect(validateIPv4Config({ mode: 'dhcp', dns: Array.from({ length: MAX_DNS_SERVERS }, (_, index) => `192.0.2.${index + 1}`) })).toBeNull();
		expect(validateIPv4Config({ mode: 'dhcp', dns: Array.from({ length: MAX_DNS_SERVERS + 1 }, (_, index) => `192.0.2.${index + 1}`) })).toBe('dns');
	});

	it('spells every IPv6 resolver the way the operating system reports it back', () => {
		// The apply is verified by comparing the requested list with what the host
		// reports; a different spelling of the same address would look like a
		// failed apply and trigger a rollback of a change that actually succeeded.
		expect(canonicalDnsServer('2001:0DB8:0000:0000:0000:0000:0000:0053')).toBe('2001:db8::53');
		expect(canonicalDnsServer('2001:DB8::53')).toBe('2001:db8::53');
		expect(canonicalDnsServer('::FFFF:192.0.2.1')).toBe('::ffff:192.0.2.1');
		expect(canonicalDnsServer('192.0.2.53')).toBe('192.0.2.53');
		expect(normalizeDnsServers(['2001:0DB8:0000:0000:0000:0000:0000:0053', '2001:db8::53', '2001:DB8:0:0:0:0:0:53'])).toEqual(['2001:db8::53']);
	});

	it('rejects malformed API shapes without throwing a native TypeError', () => {
		expect(validateIPv4Config(null)).toBe('mode');
		expect(validateIPv4Config([])).toBe('mode');
		expect(validateIPv4Config({ mode: 'static', address: 123, prefixLength: 24 })).toBe('address');
		expect(validateIPv4Config({ mode: 'dhcp', dns: '192.0.2.1' })).toBe('dns');
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.2', prefixLength: 24, gateway: 123 })).toBe('gateway');
	});
});

describe('assertIPv4Baseline', () => {
	const target: NetInterfaceInfo = {
		id: 'lan0',
		name: 'LAN',
		medium: 'wired',
		link: 'up',
		defaultRoute: true,
		mac: null,
		addresses: [{ family: 'ipv4', address: '192.0.2.10', prefixLength: 24 }],
		ipv4Mode: 'static',
		ipv4Configurable: true,
		wifiConfigurable: false,
		gateway: '192.0.2.1',
		dns: ['192.0.2.53', '2001:db8::53'],
	};

	it('accepts a form seeded from the configuration the interface still has', () => {
		expect(() => assertIPv4Baseline(target, ipv4BaselineOf(target))).not.toThrow();
		// There is no value that means "apply over whatever is there": a caller that
		// brings no baseline, or a malformed one, is refused like a stale one.
		for (const missing of [undefined, null, {}, 'x']) expect(() => assertIPv4Baseline(target, missing)).toThrow(expect.objectContaining({ code: ErrorCodes.NETCONFIG_STALE }));
	});

	it('refuses a form whose interface was meanwhile switched to DHCP or re-addressed', () => {
		// A system tool or another client changed the interface after the form
		// opened; applying the old form would silently undo that change.
		const seededFrom = ipv4BaselineOf(target);
		const dhcpNow: NetInterfaceInfo = { ...target, ipv4Mode: 'dhcp', gateway: '192.0.2.254' };
		expect(() => assertIPv4Baseline(dhcpNow, seededFrom)).toThrow(expect.objectContaining({ code: ErrorCodes.NETCONFIG_STALE }));
		expect(() => assertIPv4Baseline({ ...target, addresses: [{ family: 'ipv4', address: '192.0.2.20', prefixLength: 24 }] }, seededFrom)).toThrow();
		expect(() => assertIPv4Baseline({ ...target, dns: ['192.0.2.53'] }, seededFrom)).toThrow();
	});

	it('treats a malformed baseline from the wire as stale rather than crashing', () => {
		for (const value of [null, [], 'x', { mode: 'static' }, { ...ipv4BaselineOf(target), dns: 'nope' }]) expect(() => assertIPv4Baseline(target, value)).toThrow(expect.objectContaining({ code: ErrorCodes.NETCONFIG_STALE }));
	});
});

describe('isIPv4ConfigUnchanged', () => {
	const target = {
		id: 'lan0',
		name: 'LAN',
		medium: 'wired' as const,
		link: 'up' as const,
		defaultRoute: true,
		mac: null,
		addresses: [{ family: 'ipv4' as const, address: '192.0.2.10', prefixLength: 24 }],
		ipv4Mode: 'static' as const,
		ipv4Configurable: true,
		wifiConfigurable: false,
		gateway: '192.0.2.1',
		dns: ['2001:db8::53'],
	};

	it('skips an unchanged address while preserving DNS', () => {
		expect(isIPv4ConfigUnchanged(target, { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1' })).toBe(true);
		expect(isIPv4ConfigUnchanged({ ...target, ipv4Mode: 'dhcp' }, { mode: 'dhcp' })).toBe(true);
	});

	it('obtains a lease when DHCP is saved on a leaseless interface, but leaves a DNS-only change to the DNS path', () => {
		// Saving DHCP on an interface stuck on APIPA or without any IPv4 address is
		// a request to obtain the lease, not a no-op to report as applied. A DNS
		// change on such an interface must still be possible without a lease.
		const dhcp = { ...target, ipv4Mode: 'dhcp' as const, gateway: null };
		const apipa = { ...dhcp, addresses: [{ family: 'ipv4' as const, address: '169.254.10.20', prefixLength: 16 }] };
		const noIPv4 = { ...dhcp, addresses: [{ family: 'ipv6' as const, address: '2001:db8::10', prefixLength: 64 }] };
		expect(planIPv4Change(dhcp, { mode: 'dhcp' })).toEqual({ unchanged: true, addressingChanged: false });
		expect(planIPv4Change(apipa, { mode: 'dhcp' })).toEqual({ unchanged: false, addressingChanged: true });
		expect(planIPv4Change(noIPv4, { mode: 'dhcp' })).toEqual({ unchanged: false, addressingChanged: true });
		expect(planIPv4Change(apipa, { mode: 'dhcp', dns: ['192.0.2.53'] })).toEqual({ unchanged: false, addressingChanged: false });
		expect(planIPv4Change(dhcp, { mode: 'dhcp', dns: [] })).toEqual({ unchanged: false, addressingChanged: false });
		// With the link down there is no lease to obtain: DHCP on DHCP is unchanged,
		// and a switch to DHCP owes no lease until the cable is back.
		expect(planIPv4Change({ ...apipa, link: 'down' as const }, { mode: 'dhcp' })).toEqual({ unchanged: true, addressingChanged: false });
		expect(leaseRequired({ link: 'up' })).toBe(true);
		expect(leaseRequired({ link: 'unknown' })).toBe(true);
		expect(leaseRequired({ link: 'down' })).toBe(false);
		expect(planIPv4Change(target, { mode: 'static', address: '192.0.2.11', prefixLength: 24, gateway: '192.0.2.1' })).toEqual({ unchanged: false, addressingChanged: true });
	});

	it('treats any explicit DNS choice or address change as a mutation', () => {
		expect(isIPv4ConfigUnchanged(target, { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: [] })).toBe(false);
		expect(isIPv4AddressingUnchanged(target, { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: [] })).toBe(true);
		expect(isIPv4ConfigUnchanged(target, { mode: 'static', address: '192.0.2.11', prefixLength: 24, gateway: '192.0.2.1' })).toBe(false);
		expect(isIPv4ConfigUnchanged({ ...target, ipv4Configurable: false }, { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1' })).toBe(false);
	});
});

describe('assertAppliedIPv4State', () => {
	const iface = {
		id: 'lan0',
		name: 'LAN',
		medium: 'wired' as const,
		link: 'up' as const,
		defaultRoute: true,
		mac: null,
		addresses: [{ family: 'ipv4' as const, address: '192.0.2.10', prefixLength: 24 }],
		ipv4Mode: 'static' as const,
		ipv4Configurable: true,
		wifiConfigurable: false,
		gateway: '192.0.2.1',
		dns: ['2001:db8::53', '192.0.2.53'],
	};
	const state: NetworkStateInfo = { interfaces: [iface], primaryID: 'lan0', detail: 'full', known: true, capabilities: { ipv4: true, wifi: false, staticGatewayRequired: false }, ipv4ProfilesUnavailable: false };

	it('accepts the exact address, route and normalized DNS result', () => {
		expect(() => assertAppliedIPv4State(state, 'lan0', { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.53', '2001:DB8::53'] })).not.toThrow();
	});

	it('compares only the DNS family the request names', () => {
		// Windows writes each family on its own and keeps the IPv6 server the request
		// left out; the helper answered success for exactly that result.
		expect(() => assertAppliedIPv4State(state, 'lan0', { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.53'] })).not.toThrow();
		expect(() => assertAppliedIPv4State(state, 'lan0', { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['198.51.100.53'] })).toThrow('DNS');
		expect(() => assertAppliedIPv4State({ ...state, interfaces: [{ ...iface, dns: ['192.0.2.53', '198.51.100.53', '2001:db8::53'] }] }, 'lan0', { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.53'] })).toThrow('DNS');
	});

	it('rejects a spoofed success whose fresh state does not match', () => {
		expect(() => assertAppliedIPv4State(state, 'lan0', { mode: 'static', address: '192.0.2.11', prefixLength: 24, gateway: '192.0.2.1' })).toThrow('address');
		expect(() => assertAppliedIPv4State({ ...state, known: false }, 'lan0', { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1' })).toThrow('verified');
	});

	it('does not demand live resolvers from a link that is down', () => {
		// Saving DHCP with custom DNS on an unplugged card: the platform layer writes
		// and verifies the saved profile, because NetworkManager reports no servers at
		// all for a device it could not activate (measured: `nmcli device show` prints
		// no IP4.DNS line while the profile holds them). Demanding them here failed a
		// change that had already been made, after the helper returned - so nothing
		// rolled it back and the user was told the opposite of what happened.
		const unplugged: NetworkStateInfo = { ...state, interfaces: [{ ...iface, link: 'down', ipv4Mode: 'dhcp', addresses: [], gateway: null, dns: [] }] };
		expect(() => assertAppliedIPv4State(unplugged, 'lan0', { mode: 'dhcp', dns: ['192.0.2.53'] }, true, false)).not.toThrow();
		// With the link up the same empty result is a real failure.
		const live: NetworkStateInfo = { ...state, interfaces: [{ ...iface, ipv4Mode: 'dhcp', addresses: [{ family: 'ipv4', address: '192.0.2.10', prefixLength: 24 }], dns: [] }] };
		expect(() => assertAppliedIPv4State(live, 'lan0', { mode: 'dhcp', dns: ['192.0.2.53'] }, true, true)).toThrow('DNS');
		// And a DNS-only change on a connected card is still verified against the
		// live servers - that case reaches here with no addressing change, not with a
		// link that is down.
		expect(() => assertAppliedIPv4State(live, 'lan0', { mode: 'dhcp', dns: ['192.0.2.53'] }, false, true)).toThrow('DNS');
	});

	it('demands a DHCP lease only when DHCP was just switched on', () => {
		// A DNS-only change on an interface already on DHCP without a lease (cable
		// out, no server answering) succeeded exactly as requested; the reader drops
		// APIPA, so such an interface legitimately reports no IPv4 address.
		const leaseless: NetworkStateInfo = { ...state, interfaces: [{ ...iface, ipv4Mode: 'dhcp', addresses: [], gateway: null, dns: ['192.0.2.53'] }] };
		expect(() => assertAppliedIPv4State(leaseless, 'lan0', { mode: 'dhcp', dns: ['192.0.2.53'] }, false)).not.toThrow();
		expect(() => assertAppliedIPv4State(leaseless, 'lan0', { mode: 'dhcp', dns: ['192.0.2.53'] }, true)).toThrow('lease');
		expect(() => assertAppliedIPv4State(leaseless, 'lan0', { mode: 'dhcp' })).toThrow('lease');
	});
});

describe('isValidSSID', () => {
	it('accepts a name that fits the 32-octet field', () => {
		expect(isValidSSID('home')).toBe(true);
		expect(isValidSSID('x'.repeat(32))).toBe(true);
	});

	it('bounds the decoded name without pretending to know its octets', () => {
		// The bound is on the DECODED text, which is no longer the SSID's own byte
		// count: a 32-octet name whose every byte was undecodable arrives as 96
		// bytes of U+FFFD. Holding that to 32 refused networks the scan had listed.
		// The real 32-octet rule lives where the bytes are, and every join has to
		// match this name against a fresh scan regardless.
		expect(isValidSSID('ě'.repeat(17))).toBe(true);
		expect(isValidSSID('�'.repeat(32))).toBe(true);
		expect(isValidSSID('x'.repeat(97))).toBe(false);
	});

	it('rejects an empty name', () => {
		expect(isValidSSID('')).toBe(false);
	});

	it('rejects NUL because process arguments cannot carry it', () => {
		expect(isValidSSID('home\0guest')).toBe(false);
	});

	it('rejects non-string API input', () => {
		expect(isValidSSID(123)).toBe(false);
	});
});

describe('Unix interface names', () => {
	it('enforces the kernel limit in UTF-8 bytes', () => {
		expect(assertDeviceName('enp6s18')).toBe('enp6s18');
		expect(() => assertDeviceName('ž'.repeat(8))).toThrow();
		expect(() => assertDeviceName('bad/name')).toThrow();
	});
});

describe('Wi-Fi password handling', () => {
	it('bounds and validates the value written to stdin', () => {
		expect(isValidWifiPassword('')).toBe(true);
		expect(isValidWifiPassword('a'.repeat(MAX_WIFI_PASSWORD_BYTES))).toBe(true);
		expect(isValidWifiPassword('a'.repeat(MAX_WIFI_PASSWORD_BYTES + 1))).toBe(false);
		expect(isValidWifiPassword('secret\0suffix')).toBe(false);
		expect(isValidWifiPassword('secret\nsuffix')).toBe(false);
		expect(isValidWifiPassword(123)).toBe(false);
	});
});

describe('network mutation serialization', () => {
	it('never overlaps two host network changes', async () => {
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>(resolve => (releaseFirst = resolve));
		const events: string[] = [];
		const first = runNetworkMutation(async () => {
			events.push('first:start');
			await firstGate;
			events.push('first:end');
		});
		await Promise.resolve();
		const second = runNetworkMutation(async () => {
			events.push('second:start');
			events.push('second:end');
		}).catch(error => error);
		await Promise.resolve();
		expect(events).toEqual(['first:start']);

		releaseFirst();
		await first;
		expect((await second).code).toBe('NETCONFIG_BUSY');
		expect(events).toEqual(['first:start', 'first:end']);
	});
});

describe('network capability cache', () => {
	const denied = { ipv4: false, wifi: false, staticGatewayRequired: false };
	const allowed = { ipv4: true, wifi: true, staticGatewayRequired: false };
	// A host that can already change addressing but cannot yet read Wi-Fi names.
	const partial = { ipv4: true, wifi: false, staticGatewayRequired: false };
	afterEach(resetNetworkCapabilitiesCache);

	it('retries a negative result quickly and retains a positive result longer', async () => {
		resetNetworkCapabilitiesCache();
		let probes = 0;
		const probe = async () => (++probes === 1 ? denied : allowed);
		expect(await readCachedCapabilities(probe, 0)).toEqual(denied);
		expect(await readCachedCapabilities(probe, CAPABILITY_NEGATIVE_TTL_MS - 1)).toEqual(denied);
		expect(await readCachedCapabilities(probe, CAPABILITY_NEGATIVE_TTL_MS)).toEqual(allowed);
		expect(await readCachedCapabilities(probe, CAPABILITY_NEGATIVE_TTL_MS + CAPABILITY_POSITIVE_TTL_MS - 1)).toEqual(allowed);
		expect(probes).toBe(2);
	});

	it('keeps re-checking while any capability is still false', async () => {
		// Location Services on macOS is granted while the app runs and nothing tells
		// us: holding `ipv4 true, wifi false` for the long interval left the Wi-Fi
		// section greyed out for minutes after the user had already allowed it.
		resetNetworkCapabilitiesCache();
		let probes = 0;
		const probe = async () => (++probes === 1 ? partial : allowed);
		expect(await readCachedCapabilities(probe, 0)).toEqual(partial);
		expect(await readCachedCapabilities(probe, CAPABILITY_NEGATIVE_TTL_MS - 1)).toEqual(partial);
		expect(await readCachedCapabilities(probe, CAPABILITY_NEGATIVE_TTL_MS)).toEqual(allowed);
		// Once nothing is outstanding the answer is held for the long interval.
		expect(await readCachedCapabilities(probe, CAPABILITY_NEGATIVE_TTL_MS + CAPABILITY_POSITIVE_TTL_MS - 1)).toEqual(allowed);
		expect(probes).toBe(2);
	});

	it('shares one in-flight probe and does not let it overwrite an invalidation', async () => {
		resetNetworkCapabilitiesCache();
		let resolveProbe: ((value: typeof allowed) => void) | undefined;
		let probes = 0;
		const probe = () => {
			probes++;
			return new Promise<typeof allowed>(resolve => (resolveProbe = resolve));
		};
		const first = readCachedCapabilities(probe, 0);
		const second = readCachedCapabilities(probe, 1);
		expect(probes).toBe(1);
		resetNetworkCapabilitiesCache();
		const afterReset = readCachedCapabilities(async () => denied, 2);
		resolveProbe?.(allowed);
		expect(await Promise.all([first, second])).toEqual([allowed, allowed]);
		expect(await afterReset).toEqual(denied);
		expect(await readCachedCapabilities(async () => allowed, 3)).toEqual(denied);
	});
});

describe('splitNmcliFields', () => {
	it('splits on unescaped colons', () => {
		expect(splitNmcliFields('home:70:WPA2:*')).toEqual(['home', '70', 'WPA2', '*']);
	});

	it('keeps an escaped colon inside a value', () => {
		// An SSID containing a colon is legal and nmcli escapes it — a naive split
		// would tear it into two fields and shift every column after it.
		expect(splitNmcliFields('cafe\\:wifi:55:WPA2:')).toEqual(['cafe:wifi', '55', 'WPA2', '']);
	});

	it('keeps an escaped backslash', () => {
		expect(splitNmcliFields('back\\\\slash:10')).toEqual(['back\\slash', '10']);
	});
});

describe('parseNmcliWifiList', () => {
	it('parses signal, security and the active marker', () => {
		const result = parseNmcliWifiList('home:02\\:00\\:5E\\:40\\:00\\:01:82:WPA2:*\nguest:02\\:00\\:5E\\:40\\:00\\:02:47::\n');
		expect(result).toEqual([
			{ ssid: 'home', bssid: '02:00:5E:40:00:01', signal: 82, secured: true, security: 'WPA2', supported: true, active: true },
			{ ssid: 'guest', bssid: '02:00:5E:40:00:02', signal: 47, secured: false, security: '', supported: true, active: false },
		]);
	});

	it('drops hidden networks, which cannot be joined by name', () => {
		expect(parseNmcliWifiList(':02\\:00\\:5E\\:40\\:00\\:01:60:WPA2:\nhome:02\\:00\\:5E\\:40\\:00\\:02:40:WPA2:')).toEqual([{ ssid: 'home', bssid: '02:00:5E:40:00:02', signal: 40, secured: true, security: 'WPA2', supported: true, active: false }]);
	});

	it('keeps equal SSIDs with different BSSIDs and security separate', () => {
		const result = parseNmcliWifiList('home:02\\:00\\:5E\\:40\\:00\\:01:88::\nhome:02\\:00\\:5E\\:40\\:00\\:02:40:WPA2:');
		expect(result.map(item => ({ bssid: item.bssid, secured: item.secured }))).toEqual([
			{ bssid: '02:00:5E:40:00:01', secured: false },
			{ bssid: '02:00:5E:40:00:02', secured: true },
		]);
	});

	it('keeps the active flag when the strongest row is not the associated one', () => {
		const result = parseNmcliWifiList('home:02\\:00\\:5E\\:40\\:00\\:01:40:WPA2:*\nhome:02\\:00\\:5E\\:40\\:00\\:01:88:WPA2:');
		expect(result[0]).toMatchObject({ signal: 88, active: true });
	});

	it('keeps the active flag when the weaker associated row arrives last', () => {
		const result = parseNmcliWifiList('home:02\\:00\\:5E\\:40\\:00\\:01:88:WPA2:\nhome:02\\:00\\:5E\\:40\\:00\\:01:40:WPA2:*');
		expect(result[0]).toMatchObject({ signal: 88, active: true });
	});

	it('sorts strongest first', () => {
		expect(parseNmcliWifiList('weak::10:WPA2:\nstrong::90:WPA2:\nmid::50:WPA2:').map(n => n.ssid)).toEqual(['strong', 'mid', 'weak']);
	});

	it('reports an unparseable signal as unknown rather than zero', () => {
		expect(parseNmcliWifiList('home::--:WPA2:')[0]?.signal).toBeNull();
	});

	it('only supports open and personal WPA networks', () => {
		const parsed = parseNmcliWifiList('Open::80::\nPersonal::70:WPA2:\nEnterprise::60:WPA2 802.1X:\nLegacy::50:WEP:\n');
		expect(parsed.find(item => item.ssid === 'Open')).toMatchObject({ supported: true, secured: false });
		expect(parsed.find(item => item.ssid === 'Personal')).toMatchObject({ supported: true, secured: true });
		expect(parsed.find(item => item.ssid === 'Enterprise')).toMatchObject({ supported: false });
		expect(parsed.find(item => item.ssid === 'Legacy')).toMatchObject({ supported: false });
	});
});

describe('parseNmcliIPv4Method', () => {
	it('accepts only methods the editor can preserve', () => {
		expect(parseNmcliIPv4Method('auto\n')).toBe('dhcp');
		expect(parseNmcliIPv4Method('manual')).toBe('static');
		for (const method of ['shared', 'link-local', 'disabled', '', 'future-mode']) expect(parseNmcliIPv4Method(method)).toBe('unknown');
	});
});

describe('parseNmcliIPv4Profile', () => {
	const plain = ['connection.interface-name:eth0', 'connection.multi-connect:0', 'ipv4.method:auto', 'ipv4.never-default:no', 'ipv4.gateway:', 'ipv4.addresses:', 'ipv4.routes:', 'ipv4.route-table:0', 'ipv4.routing-rules:'].join('\n');

	it('accepts only plain automatic or single-address manual profiles', () => {
		expect(parseNmcliIPv4Profile(plain, 'eth0', 1)).toEqual({ method: 'auto', gateway: null, address: null, prefixLength: null, safe: true });
		expect(parseNmcliIPv4Profile(plain.replace('ipv4.method:auto', 'ipv4.method:manual').replace('ipv4.gateway:', 'ipv4.gateway:192.0.2.1').replace('ipv4.addresses:', 'ipv4.addresses:192.0.2.10/24'), 'eth0', 1)).toEqual({ method: 'manual', gateway: '192.0.2.1', address: '192.0.2.10', prefixLength: 24, safe: true });
	});

	it('rejects routing policy and address shapes the editor cannot preserve', () => {
		for (const unsafe of [plain.replace('ipv4.never-default:no', 'ipv4.never-default:yes'), plain.replace('ipv4.routes:', 'ipv4.routes:0.0.0.0/0 192.0.2.254'), plain.replace('ipv4.route-table:0', 'ipv4.route-table:100'), plain.replace('ipv4.routing-rules:', 'ipv4.routing-rules:priority 100 from 192.0.2.0/24'), plain.replace('ipv4.addresses:', 'ipv4.addresses:192.0.2.10/24')]) {
			expect(parseNmcliIPv4Profile(unsafe, 'eth0', 1).safe).toBe(false);
		}
	});

	it('rejects a profile that is generic, multi-connect, duplicated, or bound elsewhere', () => {
		expect(parseNmcliIPv4Profile(plain.replace('connection.interface-name:eth0', 'connection.interface-name:'), 'eth0', 1).safe).toBe(false);
		expect(parseNmcliIPv4Profile(plain.replace('connection.interface-name:eth0', 'connection.interface-name:eth1'), 'eth0', 1).safe).toBe(false);
		expect(parseNmcliIPv4Profile(plain.replace('connection.multi-connect:0', 'connection.multi-connect:2'), 'eth0', 1).safe).toBe(false);
		expect(parseNmcliIPv4Profile(plain, 'eth0', 2).safe).toBe(false);
	});

	it('keeps a /0 manual profile read-only', () => {
		const zero = plain.replace('ipv4.method:auto', 'ipv4.method:manual').replace('ipv4.gateway:', 'ipv4.gateway:192.0.2.1').replace('ipv4.addresses:', 'ipv4.addresses:192.0.2.10/0');
		expect(parseNmcliIPv4Profile(zero, 'eth0', 1).safe).toBe(false);
	});

	it('keeps a /32 profile with an off-link gateway read-only', () => {
		const hostRoute = plain.replace('ipv4.method:auto', 'ipv4.method:manual').replace('ipv4.gateway:', 'ipv4.gateway:192.0.2.1').replace('ipv4.addresses:', 'ipv4.addresses:192.0.2.10/32');
		expect(parseNmcliIPv4Profile(hostRoute, 'eth0', 1).safe).toBe(false);
	});
});

describe('isWindowsInterfaceID', () => {
	it('accepts a canonical braced GUID', () => {
		expect(isWindowsInterfaceID('{2B1F0E8A-4C3D-4E5F-9A7B-1C2D3E4F5A6B}')).toBe(true);
	});

	it('rejects anything else', () => {
		for (const value of ['2B1F0E8A-4C3D-4E5F-9A7B-1C2D3E4F5A6B', '{not-a-guid}', '', "{2B1F0E8A-4C3D-4E5F-9A7B-1C2D3E4F5A6B}'; calc; '"]) expect(isWindowsInterfaceID(value)).toBe(false);
	});
});

describe('firstLine', () => {
	it('keeps only the reason out of a PowerShell error block', () => {
		// Captured shape: the message, then the offending command, then a caret
		// ruler. Showing all three would put our own script in the user's dialog.
		const blob = 'Set-NetIPInterface : Access is denied.\nAt line:1 char:507\n+ ... Continue; Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 ...\n+                 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~';
		expect(firstLine(blob)).toBe('Set-NetIPInterface : Access is denied.');
	});

	it('keeps a single-line message from a Unix tool intact', () => {
		expect(firstLine('** Error: Command requires admin privileges.')).toBe('** Error: Command requires admin privileges.');
	});

	it('skips leading blank lines rather than returning nothing', () => {
		expect(firstLine('\n\n   Not authorized to control networking.\n')).toBe('Not authorized to control networking.');
	});

	it('yields an empty string for nothing at all, so the caller can fall back', () => {
		expect(firstLine(undefined)).toBe('');
		expect(firstLine('   \n  \n')).toBe('');
	});
});

describe('isValidSSID on a name the radio reported', () => {
	it('accepts a name whose undecodable octets inflated the decoded form', () => {
		// An SSID is a byte sequence and need not be UTF-8, so a scanner decodes an
		// undecodable octet to U+FFFD — three bytes for one. Measuring the decoded
		// form against 32 refused a 31-octet name the scan had just listed.
		const decode = (bytes: number[]): string => new TextDecoder().decode(Uint8Array.from(bytes));
		const ascii = (text: string): number[] => [...new TextEncoder().encode(text)];
		expect(isValidSSID(decode([...ascii('a'.repeat(30)), 0xff]))).toBe(true);
		expect(isValidSSID(decode([...ascii('b'.repeat(31)), 0xff]))).toBe(true);
		// A whole 32-octet name of undecodable bytes is 96 bytes decoded, and still fits.
		expect(isValidSSID(decode(new Array(32).fill(0xff)))).toBe(true);
	});

	it('still refuses what could never have been an SSID', () => {
		expect(isValidSSID('')).toBe(false);
		expect(isValidSSID('x'.repeat(97))).toBe(false);
		expect(isValidSSID('a\0b')).toBe(false);
		expect(isValidSSID(undefined)).toBe(false);
	});

	it('leaves a platform rule to its platform', () => {
		// A control character makes a Windows profile document malformed, but the
		// same name is joinable through NetworkManager. The Windows writer refuses it;
		// the shared gate every platform passes through does not.
		expect(isValidSSID('Net')).toBe(true);
	});
});

describe('isWifiHexKey', () => {
	it('recognises exactly 64 hexadecimal digits, in either case', () => {
		expect(isWifiHexKey('0123456789abcdef'.repeat(4))).toBe(true);
		expect(isWifiHexKey('0123456789ABCDEF'.repeat(4))).toBe(true);
	});

	it('refuses anything that is not one', () => {
		// Off by one in either direction, a non-hex digit in the last place, and the
		// wrong type. A false positive here writes a Windows profile that declares a
		// passphrase as a raw key, which is accepted and then never authenticates.
		expect(isWifiHexKey('0123456789abcdef'.repeat(3))).toBe(false);
		expect(isWifiHexKey(`${'0123456789abcdef'.repeat(4)}0`)).toBe(false);
		expect(isWifiHexKey(`${'a'.repeat(63)}z`)).toBe(false);
		expect(isWifiHexKey(undefined)).toBe(false);
	});
});

describe('isValidWifiKey', () => {
	// Measured against NetworkManager 1.52: it counts bytes for a WPA-PSK key, so
	// four accented characters pass as eight, and 64 characters are a key only when
	// every one of them is a hex digit.
	it('holds a WPA2 key to the pre-shared key rule', () => {
		for (const password of ['12345678', 'a'.repeat(63), '0'.repeat(64), 'A'.repeat(64), 'heslo123', 'ěěěě']) expect(isValidWifiKey('WPA2', password)).toBe(true);
		for (const password of ['', '1234567', 'ěěě', 'z'.repeat(64), 'z'.repeat(65), '0'.repeat(63) + 'z']) expect(isValidWifiKey('WPA2', password)).toBe(false);
	});

	it('puts no length rule on a network that offers WPA3', () => {
		// SAE derives from the password instead of hashing it to a fixed-length key,
		// and NetworkManager accepts any length for it. Refusing a short one would
		// refuse a password that works.
		for (const security of ['WPA3', 'WPA2 WPA3', 'wpa3', 'SAE']) {
			expect(isValidWifiKey(security, 'abc')).toBe(true);
			expect(isValidWifiKey(security, 'z'.repeat(64))).toBe(true);
			expect(isValidWifiKey(security, '')).toBe(false);
		}
	});
});

describe('isUnambiguousWifiTarget', () => {
	const row = (ssid: string, bssid: string | null) => ({ ssid, bssid });

	it('accepts a name only one network in range goes by', () => {
		expect(isUnambiguousWifiTarget([row('Office', null), row('Guests', null)], row('Office', null))).toBe(true);
	});

	it('refuses a name two networks share with nothing to tell them apart', () => {
		// macOS reports no BSSID at all, so this is its normal shape for a name
		// carried by an open access point and an unrelated secured one.
		const rows = [row('Guests', null), row('Guests', null)];
		expect(isUnambiguousWifiTarget(rows, rows[0]!)).toBe(false);
	});

	it('accepts a shared name once an access point is named', () => {
		const rows = [row('Guests', 'AA:BB:CC:DD:EE:01'), row('Guests', 'AA:BB:CC:DD:EE:02')];
		expect(isUnambiguousWifiTarget(rows, rows[0]!)).toBe(true);
	});

	it('is the rule the join itself applies, so the screen cannot offer more', () => {
		// Both sides read this one function; drifting apart is what let the screen
		// accept a row the join then refused after the password had been typed.
		const rows: NetWifiNetwork[] = [
			{ ssid: 'Guests', bssid: null, signal: 40, secured: false, security: '', supported: true, active: false },
			{ ssid: 'Guests', bssid: null, signal: 80, secured: true, security: 'WPA2', supported: true, active: false },
		];
		expect(isUnambiguousWifiTarget(rows, rows[0]!)).toBe(false);
		expect(resolveJoinTarget(rows, 'Guests', null)).toBe('ambiguous');
	});
});

it('keeps a real safety reserve beyond the whole transaction and its rollback', () => {
	// The activation is the longest step but never the only one: the pre-checks
	// and the two read-backs run inside the checkpoint as well. Measuring the
	// reserve against the activation alone would report thirty seconds of margin
	// where there is one.
	const longest = Math.max(NETWORK_MANAGER_IPV4_TRANSACTION_TIMEOUT_MS, NETWORK_MANAGER_WIFI_TRANSACTION_TIMEOUT_MS);
	expect(NETWORK_MANAGER_CHECKPOINT_TIMEOUT_SECONDS * 1000 - longest - NETWORK_MANAGER_ROLLBACK_TIMEOUT_MS).toBeGreaterThanOrEqual(NETWORK_MANAGER_CHECKPOINT_SAFETY_MS);
	// Each budget has to cover the steps it is named after.
	expect(NETWORK_MANAGER_IPV4_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(NETWORK_MANAGER_MUTATION_TIMEOUT_MS + NETWORK_MANAGER_PROFILE_UPDATE_TIMEOUT_MS);
	expect(NETWORK_MANAGER_WIFI_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(NETWORK_MANAGER_MUTATION_TIMEOUT_MS);
});
