import { describe, expect, it } from 'bun:test';
import { isIPv4, isIPv6, isValidSSID, validateIPv4Config, type NetIPv4Config } from '@shared';
import { nmcliActivateArgs, nmcliCheckpointArgs, nmcliModifyArgs, nmcliWifiConnectArgs, parseLinuxCapabilities, parseNmcliActiveConnections, parseNmcliDns, parseNmcliIPv4Method, parseNmcliPermission, parseNmcliWifiList, parseProcNetWireless, splitNmcliFields } from '../../src/system-network-linux.ts';
import { isWindowsInterfaceID, parseElevation, windowsApplyIPv4Command } from '../../src/system-network-windows.ts';
import { assertDeviceName, firstLine, isIPv4AddressingUnchanged, isIPv4ConfigUnchanged, isValidWifiPassword, MAX_WIFI_PASSWORD_BYTES, runNetworkMutation } from '../../src/system-network.ts';

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
		expect(nmcliActivateArgs(uuid)).toEqual(['connection', 'up', 'uuid', uuid]);
	});

	it('wraps modification and activation in one device checkpoint', () => {
		const uuid = '11111111-1111-1111-1111-111111111111';
		const args = nmcliCheckpointArgs('wlan0', uuid, { mode: 'dhcp' }, 'success-marker');
		expect(args.slice(0, 6)).toEqual(['device', 'checkpoint', '--timeout', '100', 'wlan0', '--']);
		expect(args.join(' ')).toContain('connection up uuid');
		expect(args).toContain('90');
		const modify = args.indexOf('connection');
		expect(args.slice(modify, modify + 4)).toEqual(['connection', 'modify', 'uuid', uuid]);
	});

	it('reapplies a DNS-only profile without cycling the connection', () => {
		const args = nmcliCheckpointArgs('wlan0', 'uuid', { mode: 'dhcp', dns: ['192.0.2.53'] }, 'marker', false);
		expect(args.join(' ')).toContain('device reapply');
		expect(args.join(' ')).not.toContain('connection up uuid');
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
	const permissions = (modify: string, control: string, scan: string): string => [`org.freedesktop.NetworkManager.settings.modify.system:${modify}`, `org.freedesktop.NetworkManager.network-control:${control}`, `org.freedesktop.NetworkManager.wifi.scan:${scan}`].join('\n');

	it('requires both profile modification and activation for IPv4 writes', () => {
		expect(parseLinuxCapabilities(permissions('yes', 'yes', 'yes'))).toEqual({ ipv4: true, wifi: true, staticGatewayRequired: false });
		expect(parseLinuxCapabilities(permissions('yes', 'no', 'yes'))).toEqual({ ipv4: false, wifi: false, staticGatewayRequired: false });
		expect(parseLinuxCapabilities(permissions('auth', 'yes', 'yes'))).toEqual({ ipv4: false, wifi: false, staticGatewayRequired: false });
	});

	it('requires the separate scan permission before offering Wi-Fi actions', () => {
		expect(parseLinuxCapabilities(permissions('yes', 'yes', 'no'))).toEqual({ ipv4: true, wifi: false, staticGatewayRequired: false });
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
