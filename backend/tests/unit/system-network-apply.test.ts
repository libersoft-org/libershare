import { describe, expect, it } from 'bun:test';
import { isIPv4, isValidSSID, validateIPv4Config, type NetIPv4Config } from '@shared';
import { nmcliModifyArgs, parseNmcliActiveUUID, parseNmcliPermission, parseNmcliWifiList, parseProcNetWireless, splitNmcliFields } from '../../src/system-network-linux.ts';
import { isWindowsInterfaceID, parseElevation, windowsApplyIPv4Command } from '../../src/system-network-windows.ts';
import { firstLine } from '../../src/system-network.ts';

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

describe('validateIPv4Config', () => {
	it('accepts a DHCP config with nothing else set', () => {
		expect(validateIPv4Config({ mode: 'dhcp' })).toBeNull();
	});

	it('accepts a complete static config', () => {
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.1', '198.51.100.1'] })).toBeNull();
	});

	it('accepts a static config with no gateway, as on an isolated segment', () => {
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 24 })).toBeNull();
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
		const result = parseNmcliWifiList('home:82:WPA2:*\nguest:47::\n');
		expect(result).toEqual([
			{ ssid: 'home', signal: 82, secured: true, active: true },
			{ ssid: 'guest', signal: 47, secured: false, active: false },
		]);
	});

	it('drops hidden networks, which cannot be joined by name', () => {
		expect(parseNmcliWifiList(':60:WPA2:\nhome:40:WPA2:')).toEqual([{ ssid: 'home', signal: 40, secured: true, active: false }]);
	});

	it('collapses one row per access point into the strongest', () => {
		const result = parseNmcliWifiList('home:40:WPA2:\nhome:88:WPA2:\nhome:12:WPA2:');
		expect(result).toEqual([{ ssid: 'home', signal: 88, secured: true, active: false }]);
	});

	it('keeps the active flag when the strongest row is not the associated one', () => {
		const result = parseNmcliWifiList('home:40:WPA2:*\nhome:88:WPA2:');
		expect(result).toEqual([{ ssid: 'home', signal: 88, secured: true, active: true }]);
	});

	it('keeps the active flag when the associated row is listed after the strongest', () => {
		// Same roaming network, rows the other way round. nmcli does not order
		// access points, so the marker has to survive whichever row wins the signal
		// — otherwise a host on the weaker access point shows no active network.
		const result = parseNmcliWifiList('home:88:WPA2:\nhome:40:WPA2:*');
		expect(result).toEqual([{ ssid: 'home', signal: 88, secured: true, active: true }]);
	});

	it('sorts strongest first', () => {
		expect(parseNmcliWifiList('weak:10:WPA2:\nstrong:90:WPA2:\nmid:50:WPA2:').map(n => n.ssid)).toEqual(['strong', 'mid', 'weak']);
	});

	it('reports an unparseable signal as unknown rather than zero', () => {
		expect(parseNmcliWifiList('home:--:WPA2:')[0]?.signal).toBeNull();
	});
});

describe('nmcliModifyArgs', () => {
	it('clears the manual fields when switching to DHCP', () => {
		// NetworkManager keeps a stale ipv4.addresses on a profile whose method
		// changed, and it comes back the moment the user switches to static again.
		const args = nmcliModifyArgs('4b8a1f2c-0000-4000-8000-000000000001', { mode: 'dhcp' });
		expect(args.slice(0, 4)).toEqual(['connection', 'modify', 'uuid', '4b8a1f2c-0000-4000-8000-000000000001']);
		expect(args).toContain('auto');
		expect(args[args.indexOf('ipv4.addresses') + 1]).toBe('');
		expect(args[args.indexOf('ipv4.gateway') + 1]).toBe('');
		expect(args[args.indexOf('ipv4.dns') + 1]).toBe('');
	});

	it('sets address, gateway and DNS for a static config', () => {
		const args = nmcliModifyArgs('lan', { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.1', '198.51.100.1'] });
		expect(args[args.indexOf('ipv4.method') + 1]).toBe('manual');
		expect(args[args.indexOf('ipv4.addresses') + 1]).toBe('192.0.2.10/24');
		expect(args[args.indexOf('ipv4.gateway') + 1]).toBe('192.0.2.1');
		expect(args[args.indexOf('ipv4.dns') + 1]).toBe('192.0.2.1,198.51.100.1');
		expect(args[args.indexOf('ipv4.ignore-auto-dns') + 1]).toBe('yes');
	});

	it('does not ignore automatic DNS when the user supplied none', () => {
		const args = nmcliModifyArgs('lan', { mode: 'static', address: '192.0.2.10', prefixLength: 24 });
		expect(args[args.indexOf('ipv4.dns') + 1]).toBe('');
		expect(args[args.indexOf('ipv4.ignore-auto-dns') + 1]).toBe('no');
	});

	it('names the profile by uuid so a duplicate name cannot be picked instead', () => {
		// Profile names are not unique. Addressed as `uuid <UUID>`, nmcli cannot fall
		// back to matching the value against names.
		const args = nmcliModifyArgs('4b8a1f2c-0000-4000-8000-000000000001', { mode: 'dhcp' });
		expect(args[2]).toBe('uuid');
		expect(args[3]).toBe('4b8a1f2c-0000-4000-8000-000000000001');
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
			expect(command).toContain('Remove-NetIPAddress');
			expect(command).toContain('Remove-NetRoute');
		}
	});

	it('enables DHCP and resets the resolvers for a DHCP config', () => {
		const command = windowsApplyIPv4Command(guid, { mode: 'dhcp' });
		expect(command).toContain('-Dhcp Enabled');
		expect(command).toContain('-ResetServerAddresses');
		expect(command).not.toContain('New-NetIPAddress');
	});

	it('sets the address, prefix and gateway for a static config', () => {
		const command = windowsApplyIPv4Command(guid, { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.1'] });
		expect(command).toContain('-Dhcp Disabled');
		expect(command).toContain('-IPAddress 192.0.2.10 -PrefixLength 24 -DefaultGateway 192.0.2.1');
		expect(command).toContain('-ServerAddresses 192.0.2.1');
	});

	it('omits the gateway parameter entirely when there is none', () => {
		// Passing an empty -DefaultGateway is a parameter binding error, not a no-op.
		const command = windowsApplyIPv4Command(guid, { mode: 'static', address: '192.0.2.10', prefixLength: 24 });
		expect(command).not.toContain('-DefaultGateway');
		expect(command).toContain('-ResetServerAddresses');
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

describe('parseNmcliActiveUUID', () => {
	// `nmcli -t -f UUID,DEVICE connection show --active`, colon-separated.
	const ACTIVE = '4b8a1f2c-0000-4000-8000-000000000001:eth0\n7c2d9e40-0000-4000-8000-000000000002:wlan0\n';

	it('picks the profile active on the device asked for', () => {
		expect(parseNmcliActiveUUID(ACTIVE, 'wlan0')).toBe('7c2d9e40-0000-4000-8000-000000000002');
	});

	it('reports nothing for a device NetworkManager does not own', () => {
		// A networkd-managed NIC or a Docker bridge has no active profile, and an
		// apply must fail loudly rather than edit some other device's profile.
		expect(parseNmcliActiveUUID(ACTIVE, 'docker0')).toBeNull();
	});
});
