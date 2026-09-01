import { describe, expect, it } from 'bun:test';
import { isIPv4, isIPv6, isValidSSID, MAX_DNS_SERVERS, normalizeDnsServers, validateIPv4Config, type NetIPv4Config } from '@shared';
import { assertLinuxDnsApplied, assertLinuxIPv4Applied, assertLinuxWifiConnected, assertNetworkManagerRollback, assertNmcliActiveConnection, NETWORK_MANAGER_CHECKPOINT_SAFETY_MS, NETWORK_MANAGER_CHECKPOINT_TIMEOUT_SECONDS, NETWORK_MANAGER_MUTATION_TIMEOUT_MS, NETWORK_MANAGER_PROFILE_UPDATE_TIMEOUT_MS, NETWORK_MANAGER_ROLLBACK_TIMEOUT_MS, networkManagerCheckpointCreateArgs, networkManagerCheckpointFinishArgs, nmcliActivateArgs, nmcliModifyArgs, nmcliWifiConnectArgs, parseLinuxCapabilities, parseNetworkManagerCheckpointPath, parseNmcliActiveConnections, parseNmcliDns, parseNmcliIPv4Method, parseNmcliIPv4Profile, parseNmcliManagedDevices, parseNmcliPermission, parseNmcliWifiList, parseProcNetWireless, splitNmcliFields, withNetworkManagerCheckpoint } from '../../src/system-network-linux.ts';
import { isWindowsInterfaceID, parseElevation, windowsApplyIPv4Command } from '../../src/system-network-windows.ts';
import { assertDeviceName, CAPABILITY_NEGATIVE_TTL_MS, CAPABILITY_POSITIVE_TTL_MS, firstLine, isIPv4AddressingUnchanged, isIPv4ConfigUnchanged, isValidWifiPassword, MAX_WIFI_PASSWORD_BYTES, readCachedCapabilities, resetNetworkCapabilitiesCache, runNetworkMutation } from '../../src/system-network.ts';

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
		expect(normalizeDnsServers(['127.0.0.1', '2001:DB8::53', '127.0.0.1', '2001:db8::53'])).toEqual(['127.0.0.1', '2001:DB8::53']);
		expect(validateIPv4Config({ mode: 'dhcp', dns: Array.from({ length: MAX_DNS_SERVERS }, (_, index) => `192.0.2.${index + 1}`) })).toBeNull();
		expect(validateIPv4Config({ mode: 'dhcp', dns: Array.from({ length: MAX_DNS_SERVERS + 1 }, (_, index) => `192.0.2.${index + 1}`) })).toBe('dns');
	});

	it('rejects malformed API shapes without throwing a native TypeError', () => {
		expect(validateIPv4Config(null)).toBe('mode');
		expect(validateIPv4Config([])).toBe('mode');
		expect(validateIPv4Config({ mode: 'static', address: 123, prefixLength: 24 })).toBe('address');
		expect(validateIPv4Config({ mode: 'dhcp', dns: '192.0.2.1' })).toBe('dns');
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.2', prefixLength: 24, gateway: 123 })).toBe('gateway');
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

	it('treats any explicit DNS choice or address change as a mutation', () => {
		expect(isIPv4ConfigUnchanged(target, { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: [] })).toBe(false);
		expect(isIPv4AddressingUnchanged(target, { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: [] })).toBe(true);
		expect(isIPv4ConfigUnchanged(target, { mode: 'static', address: '192.0.2.11', prefixLength: 24, gateway: '192.0.2.1' })).toBe(false);
		expect(isIPv4ConfigUnchanged({ ...target, ipv4Configurable: false }, { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1' })).toBe(false);
	});
});

describe('isValidSSID', () => {
	it('accepts a name that fits the 32-octet field', () => {
		expect(isValidSSID('home')).toBe(true);
		expect(isValidSSID('x'.repeat(32))).toBe(true);
	});

	it('counts bytes rather than characters', () => {
		// 17 two-byte characters are 34 octets and do not fit, even though the
		// string is well under 32 characters long.
		expect(isValidSSID('ě'.repeat(17))).toBe(false);
		expect(isValidSSID('ě'.repeat(16))).toBe(true);
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
	it('keeps the secret out of the nmcli argument vector', () => {
		const secret = 'not-visible-in-proc';
		const args = nmcliWifiConnectArgs('wlan0', 'Example network', true, '02:00:5E:40:00:01');
		expect(args[0]).toBe('--ask');
		expect(args).toContain('02:00:5E:40:00:01');
		expect(args).not.toContain(secret);
		expect(args).not.toContain('password');
	});

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
		});
		await Promise.resolve();
		expect(events).toEqual(['first:start']);

		releaseFirst();
		await Promise.all([first, second]);
		expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
	});
});

describe('network capability cache', () => {
	const denied = { ipv4: false, wifi: false, staticGatewayRequired: false };
	const allowed = { ipv4: true, wifi: false, staticGatewayRequired: false };

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

describe('parseNmcliActiveConnections', () => {
	it('keys unambiguous active profile UUIDs by device', () => {
		expect([...parseNmcliActiveConnections('11111111-1111-1111-1111-111111111111:eth0\n22222222-2222-2222-2222-222222222222:wlan0\n')]).toEqual([
			['eth0', '11111111-1111-1111-1111-111111111111'],
			['wlan0', '22222222-2222-2222-2222-222222222222'],
		]);
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
		expect(parseNmcliIPv4Profile(plain, 'eth0', 1)).toEqual({ method: 'auto', gateway: null, safe: true });
		expect(parseNmcliIPv4Profile(plain.replace('ipv4.method:auto', 'ipv4.method:manual').replace('ipv4.gateway:', 'ipv4.gateway:192.0.2.1').replace('ipv4.addresses:', 'ipv4.addresses:192.0.2.10/24'), 'eth0', 1)).toEqual({ method: 'manual', gateway: '192.0.2.1', safe: true });
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
});

describe('parseNmcliManagedDevices', () => {
	it('keeps managed and disconnected Wi-Fi devices distinct from unmanaged ones', () => {
		const text = ['GENERAL.DEVICE:wlan0', 'GENERAL.NM-MANAGED:yes', '', 'GENERAL.DEVICE:wlan1', 'GENERAL.NM-MANAGED:no'].join('\n');
		expect([...parseNmcliManagedDevices(text)]).toEqual(['wlan0']);
	});
});

describe('parseNmcliDns', () => {
	it('combines IPv4 and IPv6 resolvers for each device', () => {
		const parsed = parseNmcliDns('GENERAL.DEVICE:eth0\nIP4.DNS[1]:192.0.2.53\nIP6.DNS[1]:2001:db8::53\nIP6.DNS[2]:2001\\:db8\\:\\:54\n');
		expect(parsed.get('eth0')).toEqual(['192.0.2.53', '2001:db8::53', '2001:db8::54']);
	});
});

describe('nmcliModifyArgs', () => {
	it('clears the manual fields when switching to DHCP', () => {
		// NetworkManager keeps a stale ipv4.addresses on a profile whose method
		// changed, and it comes back the moment the user switches to static again.
		const args = nmcliModifyArgs('11111111-1111-1111-1111-111111111111', { mode: 'dhcp' });
		expect(args.slice(0, 4)).toEqual(['connection', 'modify', 'uuid', '11111111-1111-1111-1111-111111111111']);
		expect(args).toContain('auto');
		expect(args[args.indexOf('ipv4.addresses') + 1]).toBe('');
		expect(args[args.indexOf('ipv4.gateway') + 1]).toBe('');
		expect(args).not.toContain('ipv4.dns');
	});

	it('changes DNS only when explicitly requested in either address mode', () => {
		const unchanged = nmcliModifyArgs('lan', { mode: 'dhcp' });
		expect(unchanged).not.toContain('ipv4.dns');
		expect(unchanged).not.toContain('ipv4.ignore-auto-dns');
		expect(unchanged).not.toContain('ipv6.dns');
		expect(unchanged).not.toContain('ipv6.ignore-auto-dns');

		const automatic = nmcliModifyArgs('lan', { mode: 'dhcp', dns: [] });
		expect(automatic[automatic.indexOf('ipv4.dns') + 1]).toBe('');
		expect(automatic[automatic.indexOf('ipv4.ignore-auto-dns') + 1]).toBe('no');
		expect(automatic[automatic.indexOf('ipv6.dns') + 1]).toBe('');
		expect(automatic[automatic.indexOf('ipv6.ignore-auto-dns') + 1]).toBe('no');

		const custom = nmcliModifyArgs('lan', { mode: 'dhcp', dns: ['2001:db8::53', '127.0.0.1'] });
		expect(custom[custom.indexOf('ipv4.dns') + 1]).toBe('127.0.0.1');
		expect(custom[custom.indexOf('ipv4.ignore-auto-dns') + 1]).toBe('yes');
		expect(custom[custom.indexOf('ipv6.dns') + 1]).toBe('2001:db8::53');
		expect(custom[custom.indexOf('ipv6.ignore-auto-dns') + 1]).toBe('yes');
	});

	it('does not rewrite addressing for a DNS-only update', () => {
		const args = nmcliModifyArgs('lan', { mode: 'dhcp', dns: ['192.0.2.53'] }, false);
		expect(args).not.toContain('ipv4.method');
		expect(args).not.toContain('ipv4.addresses');
		expect(args).not.toContain('ipv4.gateway');
		expect(args).toContain('ipv4.dns');
	});

	it('disables automatic DNS for both families when only one family is custom', () => {
		const ipv4Only = nmcliModifyArgs('lan', { mode: 'dhcp', dns: ['192.0.2.53'] });
		expect(ipv4Only[ipv4Only.indexOf('ipv4.dns') + 1]).toBe('192.0.2.53');
		expect(ipv4Only[ipv4Only.indexOf('ipv6.dns') + 1]).toBe('');
		expect(ipv4Only[ipv4Only.indexOf('ipv6.ignore-auto-dns') + 1]).toBe('yes');

		const ipv6Only = nmcliModifyArgs('lan', { mode: 'dhcp', dns: ['2001:db8::53'] });
		expect(ipv6Only[ipv6Only.indexOf('ipv4.dns') + 1]).toBe('');
		expect(ipv6Only[ipv6Only.indexOf('ipv4.ignore-auto-dns') + 1]).toBe('yes');
		expect(ipv6Only[ipv6Only.indexOf('ipv6.dns') + 1]).toBe('2001:db8::53');
	});

	it('sets address, gateway and DNS for a static config', () => {
		const args = nmcliModifyArgs('lan', { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.1', '198.51.100.1'] });
		expect(args[args.indexOf('ipv4.method') + 1]).toBe('manual');
		expect(args[args.indexOf('ipv4.addresses') + 1]).toBe('192.0.2.10/24');
		expect(args[args.indexOf('ipv4.gateway') + 1]).toBe('192.0.2.1');
		expect(args[args.indexOf('ipv4.dns') + 1]).toBe('192.0.2.1,198.51.100.1');
		expect(args[args.indexOf('ipv4.ignore-auto-dns') + 1]).toBe('yes');
	});

	it('does not ignore automatic DNS when the user explicitly requested it', () => {
		const args = nmcliModifyArgs('lan', { mode: 'static', address: '192.0.2.10', prefixLength: 24, dns: [] });
		expect(args[args.indexOf('ipv4.dns') + 1]).toBe('');
		expect(args[args.indexOf('ipv4.ignore-auto-dns') + 1]).toBe('no');
	});

	it('addresses both modify and activation by UUID rather than an ambiguous name', () => {
		const uuid = '11111111-1111-1111-1111-111111111111';
		expect(nmcliModifyArgs(uuid, { mode: 'dhcp' }).slice(0, 4)).toEqual(['connection', 'modify', 'uuid', uuid]);
		expect(nmcliActivateArgs(uuid, 'eth0')).toEqual(['connection', 'up', 'uuid', uuid, 'ifname', 'eth0']);
	});
});

describe('active NetworkManager profile binding', () => {
	const uuid = '11111111-1111-1111-1111-111111111111';

	it('accepts only one activation on the requested device', () => {
		expect(() => assertNmcliActiveConnection(new Map([['eth0', uuid]]), 'eth0', uuid)).not.toThrow();
		expect(() => assertNmcliActiveConnection(new Map([['eth1', uuid]]), 'eth0', uuid)).toThrow('unexpected device');
		expect(() =>
			assertNmcliActiveConnection(
				new Map([
					['eth0', uuid],
					['eth1', uuid],
				]),
				'eth0',
				uuid
			)
		).toThrow('unexpected device');
	});
});

describe('assertLinuxIPv4Applied', () => {
	const addr = JSON.stringify([{ ifname: 'eth0', addr_info: [{ family: 'inet', local: '192.0.2.10', prefixlen: 24 }] }]);
	const route = JSON.stringify([{ dev: 'eth0', gateway: '192.0.2.1' }]);

	it('confirms the requested live static address and gateway', () => {
		expect(() => assertLinuxIPv4Applied({ mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1' }, 'manual\n', addr, route)).not.toThrow();
	});

	it('rejects a successful command whose live route does not match', () => {
		expect(() => assertLinuxIPv4Applied({ mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1' }, 'manual', addr, JSON.stringify([{ dev: 'eth0', gateway: '192.0.2.254' }]))).toThrow('gateway');
		expect(() => assertLinuxIPv4Applied({ mode: 'static', address: '192.0.2.10', prefixLength: 24 }, 'manual', addr, route)).toThrow('unexpected default route');
	});

	it('requires a usable IPv4 lease before confirming DHCP', () => {
		expect(() => assertLinuxIPv4Applied({ mode: 'dhcp' }, 'auto\n', '[]', '[]')).toThrow('lease');
		expect(() => assertLinuxIPv4Applied({ mode: 'dhcp' }, 'auto\n', JSON.stringify([{ ifname: 'eth0', addr_info: [{ family: 'inet', local: '169.254.10.2', prefixlen: 16 }] }]), '[]')).toThrow('lease');
		expect(() => assertLinuxIPv4Applied({ mode: 'dhcp' }, 'auto\n', addr, '[]')).not.toThrow();
		expect(() => assertLinuxIPv4Applied({ mode: 'dhcp' }, 'manual\n', '[]', '[]')).toThrow('method');
	});
});

describe('Linux DNS verification', () => {
	const automatic = ['ipv4.dns:', 'ipv4.ignore-auto-dns:no', 'ipv6.dns:', 'ipv6.ignore-auto-dns:no'].join('\n');
	const custom = ['ipv4.dns:192.0.2.53', 'ipv4.ignore-auto-dns:yes', 'ipv6.dns:2001\\:db8\\:\\:53', 'ipv6.ignore-auto-dns:yes'].join('\n');

	it('accepts the requested resolver policy and live custom servers', () => {
		expect(() => assertLinuxDnsApplied({ mode: 'dhcp', dns: [] }, automatic, 'GENERAL.DEVICE:eth0\n', 'eth0')).not.toThrow();
		expect(() => assertLinuxDnsApplied({ mode: 'dhcp', dns: ['192.0.2.53', '2001:db8::53'] }, custom, 'GENERAL.DEVICE:eth0\nIP4.DNS[1]:192.0.2.53\nIP6.DNS[1]:2001\\:db8\\:\\:53\n', 'eth0')).not.toThrow();
	});

	it('rejects a command that left the wrong policy or live servers', () => {
		expect(() => assertLinuxDnsApplied({ mode: 'dhcp', dns: [] }, custom, 'GENERAL.DEVICE:eth0\n', 'eth0')).toThrow('DNS');
		expect(() => assertLinuxDnsApplied({ mode: 'dhcp', dns: ['192.0.2.53'] }, custom, 'GENERAL.DEVICE:eth0\nIP4.DNS[1]:192.0.2.54\n', 'eth0')).toThrow('DNS');
	});
});

describe('Linux Wi-Fi verification', () => {
	const networks = parseNmcliWifiList('Cafe:00\\:11\\:22\\:33\\:44\\:55:80:WPA2:*\nCafe:66\\:77\\:88\\:99\\:AA\\:BB:70:WPA2:\n');

	it('requires the selected access point to be active', () => {
		expect(() => assertLinuxWifiConnected(networks, 'Cafe', '00:11:22:33:44:55')).not.toThrow();
		expect(() => assertLinuxWifiConnected(networks, 'Cafe', '66:77:88:99:AA:BB')).toThrow('Wi-Fi');
		expect(() => assertLinuxWifiConnected(networks, 'Other', null)).toThrow('Wi-Fi');
	});
});

describe('NetworkManager checkpoint transaction', () => {
	const devicePath = '/org/freedesktop/NetworkManager/Devices/7';
	const checkpointPath = '/org/freedesktop/NetworkManager/Checkpoint/12';

	it('requests deletion of connections created after the checkpoint', () => {
		const args = networkManagerCheckpointCreateArgs(devicePath);
		expect(args.slice(-3)).toEqual([devicePath, String(NETWORK_MANAGER_CHECKPOINT_TIMEOUT_SECONDS), '2']);
		expect(args).toContain('CheckpointCreate');
		expect(parseNetworkManagerCheckpointPath(`o "${checkpointPath}"\n`)).toBe(checkpointPath);
	});

	it('keeps a real safety reserve beyond update, activation and rollback limits', () => {
		expect(NETWORK_MANAGER_CHECKPOINT_TIMEOUT_SECONDS * 1000).toBeGreaterThan(NETWORK_MANAGER_PROFILE_UPDATE_TIMEOUT_MS + NETWORK_MANAGER_MUTATION_TIMEOUT_MS + NETWORK_MANAGER_ROLLBACK_TIMEOUT_MS + NETWORK_MANAGER_CHECKPOINT_SAFETY_MS);
	});

	it('destroys a successful checkpoint and keeps the mutation', async () => {
		const events: string[] = [];
		const result = await withNetworkManagerCheckpoint({
			create: async () => {
				events.push('create');
				return checkpointPath;
			},
			mutate: async () => {
				events.push('mutate');
				return 42;
			},
			commit: async path => {
				events.push(`commit:${path}`);
			},
			rollback: async path => {
				events.push(`rollback:${path}`);
			},
		});
		expect(result).toBe(42);
		expect(events).toEqual(['create', 'mutate', `commit:${checkpointPath}`]);
		expect(networkManagerCheckpointFinishArgs('CheckpointDestroy', checkpointPath)).toContain('CheckpointDestroy');
	});

	it('rolls back immediately when the mutation fails', async () => {
		const events: string[] = [];
		const failure = new Error('mutation failed');
		const operation = withNetworkManagerCheckpoint({
			create: async () => checkpointPath,
			mutate: async () => {
				events.push('mutate');
				throw failure;
			},
			commit: async () => {
				events.push('commit');
			},
			rollback: async path => {
				events.push(`rollback:${path}`);
			},
		});
		await expect(operation).rejects.toBe(failure);
		expect(events).toEqual(['mutate', `rollback:${checkpointPath}`]);
		expect(networkManagerCheckpointFinishArgs('CheckpointRollback', checkpointPath)).toContain('CheckpointRollback');
	});

	it('reports a rollback failure instead of hiding it', async () => {
		const operation = withNetworkManagerCheckpoint({
			create: async () => checkpointPath,
			mutate: async () => {
				throw new Error('mutation failed');
			},
			commit: async () => {},
			rollback: async () => {
				throw new Error('rollback failed');
			},
		});
		await expect(operation).rejects.toBeInstanceOf(AggregateError);
	});

	it('accepts only successful per-device rollback results', () => {
		expect(() => assertNetworkManagerRollback(`a{su} 1 "${devicePath}" 0\n`)).not.toThrow();
		expect(() => assertNetworkManagerRollback(`a{su} 1 "${devicePath}" 1\n`)).toThrow();
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

describe('windowsApplyIPv4Command', () => {
	const guid = '{2B1F0E8A-4C3D-4E5F-9A7B-1C2D3E4F5A6B}';

	it('resolves the adapter by GUID rather than by its renameable name', () => {
		expect(windowsApplyIPv4Command(guid, { mode: 'dhcp' })).toContain(`$_.InterfaceGuid -eq '${guid}'`);
	});

	it('clears the old address and route before applying either mode', () => {
		for (const config of [{ mode: 'dhcp' } as NetIPv4Config, { mode: 'static', address: '192.0.2.10', prefixLength: 24 } as NetIPv4Config]) {
			const command = windowsApplyIPv4Command(guid, config);
			expect(command).toContain('$oldAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.InterfaceIndex -eq $i })');
			expect(command).toContain('$oldAddresses | Remove-NetIPAddress -Confirm:$false -ErrorAction Stop');
			expect(command).toContain("$oldRoutes = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.InterfaceIndex -eq $i -and $_.DestinationPrefix -eq '0.0.0.0/0' })");
			expect(command).toContain('$oldRoutes | Remove-NetRoute -Confirm:$false -ErrorAction Stop');
			expect(command).not.toContain('Remove-NetIPAddress -InterfaceIndex');
			expect(command).not.toContain('Remove-NetRoute -InterfaceIndex');
		}
	});

	it('enables DHCP without touching resolvers by default', () => {
		const command = windowsApplyIPv4Command(guid, { mode: 'dhcp' });
		const apply = command.split('} catch {')[0]!;
		expect(command).toContain('-Dhcp Enabled');
		expect(apply).not.toContain('Set-DnsClientServerAddress');
		expect(apply).not.toContain('New-NetIPAddress');
	});

	it('supports explicit automatic or custom DNS in DHCP mode', () => {
		expect(windowsApplyIPv4Command(guid, { mode: 'dhcp', dns: [] })).toContain('-ResetServerAddresses');
		const custom = windowsApplyIPv4Command(guid, { mode: 'dhcp', dns: ['2001:db8::53', '127.0.0.1'] });
		expect(custom).toContain("-ServerAddresses '2001:db8::53','127.0.0.1'");
	});

	it('changes only DNS when addressing is unchanged', () => {
		const command = windowsApplyIPv4Command(guid, { mode: 'dhcp', dns: ['192.0.2.53'] }, false);
		expect(command).toContain('Set-DnsClientServerAddress');
		expect(command).not.toContain('Remove-NetIPAddress');
		expect(command).not.toContain('Remove-NetRoute');
		expect(command).not.toContain('Set-NetIPInterface');
		expect(command).toContain('$oldDns4');
		expect(command).toContain('Compare-Object');
		expect(command).toContain('Set-DnsClientServerAddress -InputObject $oldDns4');
	});

	it('verifies the applied lease, route and DNS inside the rollback boundary', () => {
		const dhcp = windowsApplyIPv4Command(guid, { mode: 'dhcp', dns: [] });
		expect(dhcp).toContain('DHCP apply did not obtain a usable lease');
		expect(dhcp).toContain('DNS apply did not restore automatic policy');
		const fixed = windowsApplyIPv4Command(guid, { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.53'] });
		expect(fixed).toContain('$appliedAddresses.Count -ne 1');
		expect(fixed).toContain('$appliedRoutes.Count -ne 1');
		expect(fixed).toContain('Compare-Object');
		expect(fixed.indexOf('$appliedRoutes.Count -ne 1')).toBeLessThan(fixed.indexOf('} catch {'));
	});

	it('sets the address, prefix and gateway for a static config', () => {
		const command = windowsApplyIPv4Command(guid, { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.1'] });
		expect(command).toContain('-Dhcp Disabled');
		expect(command).toContain('-IPAddress 192.0.2.10 -PrefixLength 24');
		expect(command).toContain("New-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' -NextHop 192.0.2.1");
		expect(command).toContain("$addressState -eq 'Preferred'");
		expect(command).toContain("throw 'IPv4 address did not become usable'");
		expect(command).toContain("-ServerAddresses '192.0.2.1'");
		expect(command).toContain('$routeMetric');
		expect(command).toContain('-RouteMetric $routeMetric');
		expect(command).toContain('$applyError');
	});

	it('restores automatic and manual DNS independently for IPv4 and IPv6', () => {
		const command = windowsApplyIPv4Command(guid, { mode: 'static', address: '192.0.2.10', prefixLength: 24, dns: ['192.0.2.53'] });
		expect(command).toContain('Tcpip\\Parameters\\Interfaces\\$($adapter.InterfaceGuid)');
		expect(command).toContain('Tcpip6\\Parameters\\Interfaces\\$($adapter.InterfaceGuid)');
		expect(command).toContain('$oldDns4 = @(Get-DnsClientServerAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction Stop)');
		expect(command).toContain('$oldDns6 = @(Get-DnsClientServerAddress -InterfaceIndex $i -AddressFamily IPv6 -ErrorAction Stop)');
		expect(command).toContain('$oldDnsAutomatic4 = [string]::IsNullOrWhiteSpace($oldDnsNameServer4)');
		expect(command).toContain('$oldDnsAutomatic6 = [string]::IsNullOrWhiteSpace($oldDnsNameServer6)');
		expect(command).toContain('if ($oldDnsAutomatic4) { Set-DnsClientServerAddress -InputObject $oldDns4 -ResetServerAddresses } else { Set-DnsClientServerAddress -InputObject $oldDns4 -ServerAddresses $oldDnsServers4 }');
		expect(command).toContain('if ($oldDnsAutomatic6) { Set-DnsClientServerAddress -InputObject $oldDns6 -ResetServerAddresses } else { Set-DnsClientServerAddress -InputObject $oldDns6 -ServerAddresses $oldDnsServers6 }');
		expect(command).not.toContain('$oldDnsAutomatic =');
	});

	it('waits for restored static addresses before recreating routes', () => {
		const command = windowsApplyIPv4Command(guid, { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1' });
		expect(command).toContain('$restoredState -eq "Duplicate"');
		expect(command).toContain('$restoredState -ne "Preferred"');
		expect(command.indexOf('$restoredState -ne "Preferred"')).toBeLessThan(command.indexOf('foreach ($route in $oldRoutes)'));
	});

	it('confirms a previously usable DHCP lease and route during rollback', () => {
		const command = windowsApplyIPv4Command(guid, { mode: 'static', address: '192.0.2.10', prefixLength: 24 });
		expect(command).toContain('$oldDhcpNeedsAddress');
		expect(command).toContain('$oldDhcpNeedsRoute');
		expect(command).toContain('DHCP rollback did not restore a usable lease');
	});

	it('omits the gateway parameter entirely when there is none', () => {
		// Passing an empty -DefaultGateway is a parameter binding error, not a no-op.
		const command = windowsApplyIPv4Command(guid, { mode: 'static', address: '192.0.2.10', prefixLength: 24 });
		expect(command).not.toContain('-DefaultGateway');
		expect(command.split('} catch {')[0]).not.toContain('Set-DnsClientServerAddress');
	});

	it('stops on the first failing step', () => {
		// Without this a failed Set-NetIPInterface would be followed by a
		// New-NetIPAddress that silently lands on the wrong configuration.
		expect(windowsApplyIPv4Command(guid, { mode: 'dhcp' })).toContain('$ErrorActionPreference = "Stop"');
	});
});

describe('parseProcNetWireless', () => {
	// Captured verbatim from an associated brcmfmac adapter on Debian 12/arm64.
	// Only the interface name and levels matter; the trailing counters vary per host.
	const PROC = `Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE
 face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22
 wlan0: 0000   59.  -51.  -256        0      0      0   1077      0        0
`;

	it('reads the level of a real associated adapter', () => {
		// The same moment's `iw dev wlan0 link` reported -51 dBm, so both sources
		// must land on the same percentage or the UI would flicker between them.
		expect(parseProcNetWireless(PROC)).toEqual(new Map([['wlan0', 98]]));
	});

	it('ignores the two header lines', () => {
		expect(parseProcNetWireless(PROC).size).toBe(1);
	});

	it('reads several adapters at once', () => {
		const two = PROC + ' wlan1: 0000   30.  -75.  -256        0      0      0      0      0        0\n';
		expect(parseProcNetWireless(two)).toEqual(
			new Map([
				['wlan0', 98],
				['wlan1', 50],
			])
		);
	});

	it('refuses to turn a driver-relative level into a percentage', () => {
		// A positive level has no documented scale; inventing a number from it would
		// be worse than admitting the signal is unknown.
		expect(parseProcNetWireless(' wlan0: 0000   59.  144.  0        0      0      0      0      0        0').size).toBe(0);
	});

	it('yields nothing when no wireless driver is loaded', () => {
		expect(parseProcNetWireless('Inter-| sta-|   Quality\n face | tus | link level noise\n').size).toBe(0);
	});
});

describe('parseNmcliPermission', () => {
	// Captured from a Debian 12 host: the same command run as root and as an
	// unprivileged user. Values are not localized even on a Czech-locale system.
	const AS_ROOT = 'org.freedesktop.NetworkManager.network-control:yes\norg.freedesktop.NetworkManager.settings.modify.system:yes\n';
	const AS_USER = 'org.freedesktop.NetworkManager.network-control:auth\norg.freedesktop.NetworkManager.settings.modify.system:auth\n';
	const KEY = 'org.freedesktop.NetworkManager.settings.modify.system';

	it('reads the verdict for a privileged process', () => {
		expect(parseNmcliPermission(AS_ROOT, KEY)).toBe('yes');
	});

	it('reads "auth" for a process that would need a password prompt', () => {
		// A backend has no polkit agent, so "auth" means the write would fail —
		// the caller must treat it as not writable rather than as permitted.
		expect(parseNmcliPermission(AS_USER, KEY)).toBe('auth');
	});

	it('does not confuse one permission with another', () => {
		expect(parseNmcliPermission(AS_ROOT, 'org.freedesktop.NetworkManager.network-control')).toBe('yes');
		expect(parseNmcliPermission(AS_USER, 'org.freedesktop.NetworkManager.network-control')).toBe('auth');
	});

	it('returns null when the permission is absent', () => {
		expect(parseNmcliPermission(AS_ROOT, 'org.freedesktop.NetworkManager.wifi.share.open')).toBeNull();
	});
});

describe('parseLinuxCapabilities', () => {
	const permissions = (modify: string, control: string, scan: string, checkpoint: string = 'yes'): string => [`org.freedesktop.NetworkManager.settings.modify.system:${modify}`, `org.freedesktop.NetworkManager.network-control:${control}`, `org.freedesktop.NetworkManager.wifi.scan:${scan}`, `org.freedesktop.NetworkManager.checkpoint-rollback:${checkpoint}`].join('\n');

	it('requires both profile modification and activation for IPv4 writes', () => {
		expect(parseLinuxCapabilities(permissions('yes', 'yes', 'yes'))).toEqual({ ipv4: true, wifi: true, staticGatewayRequired: false });
		expect(parseLinuxCapabilities(permissions('yes', 'no', 'yes'))).toEqual({ ipv4: false, wifi: false, staticGatewayRequired: false });
		expect(parseLinuxCapabilities(permissions('auth', 'yes', 'yes'))).toEqual({ ipv4: false, wifi: false, staticGatewayRequired: false });
	});

	it('requires the separate scan permission before offering Wi-Fi actions', () => {
		expect(parseLinuxCapabilities(permissions('yes', 'yes', 'no'))).toEqual({ ipv4: true, wifi: false, staticGatewayRequired: false });
	});

	it('requires checkpoint permission before offering any mutation', () => {
		for (const verdict of ['auth', 'no']) expect(parseLinuxCapabilities(permissions('yes', 'yes', 'yes', verdict))).toEqual({ ipv4: false, wifi: false, staticGatewayRequired: false });
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

describe('parseElevation', () => {
	it('accepts the PowerShell boolean in either case, with trailing CRLF', () => {
		expect(parseElevation('True\r\n')).toBe(true);
		expect(parseElevation('true')).toBe(true);
	});

	it('treats anything else as not elevated', () => {
		expect(parseElevation('False\r\n')).toBe(false);
		expect(parseElevation('')).toBe(false);
	});
});
