import { describe, expect, it } from 'bun:test';
import { isIPv4, isValidSSID, isValidWifiKey, isWifiHexKey, validateIPv4Config, type NetIPv4Config } from '@shared';
import { nmcliActivateArgs, nmcliModifyArgs, parseNmcliActiveUUID, parseNmcliManagedDevices, parseNmcliPermission, parseNmcliWifiList, parseProcNetWireless, splitNmcliFields } from '../../src/system-network-linux.ts';
import { isWindowsInterfaceID, parseElevation, windowsApplyIPv4Command } from '../../src/system-network-windows.ts';
import { firstLine } from '../../src/system-network.ts';

/**
 * `isIPv4` is deliberately LEXICAL: it answers whether a string is shaped like a
 * dotted quad, nothing more. Whether such a literal can be a host's address is a
 * separate, semantic question, answered by `validateIPv4Config` below — so
 * `0.0.0.0` being accepted here and rejected there is the intended split, not a
 * contradiction.
 */
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

	it('answers false for a non-string rather than throwing', () => {
		for (const bogus of [null, undefined, 42, {}, ['192.0.2.1']]) expect(isIPv4(bogus as unknown as string)).toBe(false);
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

	// The config arrives from an RPC client, so its runtime shape is whatever was
	// sent. Every one of these used to throw a TypeError out of the dispatcher
	// instead of naming the offending field.
	it('names a field rather than throwing on a config that is not an object', () => {
		for (const bogus of [null, undefined, [], 'static', 42]) expect(validateIPv4Config(bogus as unknown as NetIPv4Config)).toBe('mode');
	});

	it('names a field rather than throwing on a non-string address', () => {
		for (const bogus of [{}, [], 42, null]) expect(validateIPv4Config({ mode: 'static', address: bogus, prefixLength: 24 } as unknown as NetIPv4Config)).toBe('address');
	});

	it('names a field rather than throwing on a dns list that is not a list', () => {
		expect(validateIPv4Config({ mode: 'dhcp', dns: '192.0.2.1' } as unknown as NetIPv4Config)).toBe('dns');
		expect(validateIPv4Config({ mode: 'dhcp', dns: { 0: '192.0.2.1' } } as unknown as NetIPv4Config)).toBe('dns');
	});

	it('names a field rather than throwing on a dns entry that is not a string', () => {
		expect(validateIPv4Config({ mode: 'dhcp', dns: [{}] } as unknown as NetIPv4Config)).toBe('dns');
		expect(validateIPv4Config({ mode: 'dhcp', dns: [null] } as unknown as NetIPv4Config)).toBe('dns');
	});

	// Semantic layer: a literal that is shaped like an address but cannot be a
	// host's. Windows deletes the previous address BEFORE setting the new one, so
	// letting the OS be the one to notice leaves the interface with neither.
	it('rejects the unspecified and limited-broadcast addresses', () => {
		expect(validateIPv4Config({ mode: 'static', address: '0.0.0.0', prefixLength: 24 })).toBe('address');
		expect(validateIPv4Config({ mode: 'static', address: '255.255.255.255', prefixLength: 24 })).toBe('address');
		// At /31 and /32 the network/broadcast rule below does not apply, so these
		// two are the only thing standing between the user and an interface
		// configured with no address at all.
		expect(validateIPv4Config({ mode: 'static', address: '0.0.0.0', prefixLength: 32 })).toBe('address');
		expect(validateIPv4Config({ mode: 'static', address: '255.255.255.255', prefixLength: 32 })).toBe('address');
		expect(validateIPv4Config({ mode: 'static', address: '0.0.0.0', prefixLength: 31 })).toBe('address');
	});

	it('rejects the network and broadcast addresses of the prefix', () => {
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.0', prefixLength: 24 })).toBe('address');
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.255', prefixLength: 24 })).toBe('address');
		// The same host in a wider prefix is a perfectly ordinary address.
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.255', prefixLength: 23 })).toBeNull();
	});

	it('allows both addresses of a point-to-point /31 and a lone /32', () => {
		// RFC 3021: a /31 has no network or broadcast address, both are usable.
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.0', prefixLength: 31 })).toBeNull();
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.1', prefixLength: 31 })).toBeNull();
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.0', prefixLength: 32 })).toBeNull();
	});

	it('rejects a gateway that is the interface itself, or unspecified', () => {
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.10' })).toBe('gateway');
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '0.0.0.0' })).toBe('gateway');
	});

	it('rejects a gateway the interface has no route to', () => {
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '198.51.100.1' })).toBe('gateway');
		// ...and accepts one inside the prefix.
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1' })).toBeNull();
	});

	it('allows an off-link gateway on a /32, where nothing is on-link', () => {
		expect(validateIPv4Config({ mode: 'static', address: '192.0.2.10', prefixLength: 32, gateway: '198.51.100.1' })).toBeNull();
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

	// A NUL is not merely unusual, it silently changes which network is joined:
	// utf16z writes it through and a Win32 LPCWSTR ends there, so "Home\0Evil"
	// becomes a profile for "Home". It also makes the profile XML malformed, and
	// on Linux the runtime throws a bare TypeError out of execFile before nmcli
	// even starts. Measured: all three.
	it('rejects a name carrying a NUL', () => {
		expect(isValidSSID(`Home${String.fromCharCode(0)}Evil`)).toBe(false);
	});

	it('rejects the control characters XML 1.0 cannot carry', () => {
		for (const code of [0x01, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x1f]) expect(isValidSSID(`Home${String.fromCharCode(code)}Net`)).toBe(false);
	});

	it('still accepts the whitespace XML does allow', () => {
		for (const code of [0x09, 0x0a, 0x0d]) expect(isValidSSID(`Home${String.fromCharCode(code)}Net`)).toBe(true);
	});

	it('rejects a non-string rather than throwing', () => {
		for (const bogus of [null, undefined, 42, {}]) expect(isValidSSID(bogus as unknown as string)).toBe(false);
	});
});

describe('isValidWifiKey', () => {
	// IEEE 802.11i allows a passphrase of 8-63 characters or a 64-hex raw key.
	// On Windows the profile is written to disk BEFORE the association is tried,
	// so a credential that could never work would replace a saved network's real
	// one purely on its way to failing.
	it('accepts a passphrase at both ends of the allowed range', () => {
		expect(isValidWifiKey('8charsxx')).toBe(true);
		expect(isValidWifiKey('x'.repeat(63))).toBe(true);
	});

	it('rejects a passphrase too short for WPA2', () => {
		for (const key of ['', 'a', '7chars!']) expect(isValidWifiKey(key)).toBe(false);
	});

	it('rejects a passphrase past 63 characters that is not a hex key', () => {
		expect(isValidWifiKey(`${'x'.repeat(63)}y`)).toBe(false);
		expect(isValidWifiKey('x'.repeat(200))).toBe(false);
	});

	it('accepts exactly 64 hex digits as a raw pre-shared key', () => {
		expect(isValidWifiKey('0123456789abcdef'.repeat(4))).toBe(true);
		expect(isValidWifiKey('0123456789ABCDEF'.repeat(4))).toBe(true);
	});

	it('rejects a non-string rather than throwing', () => {
		for (const bogus of [null, undefined, 42, ['secret']]) expect(isValidWifiKey(bogus as unknown as string)).toBe(false);
	});
});

describe('isWifiHexKey', () => {
	it('is true only for exactly 64 hex digits', () => {
		expect(isWifiHexKey('0123456789abcdef'.repeat(4))).toBe(true);
		expect(isWifiHexKey('0123456789abcdef'.repeat(3))).toBe(false);
		expect(isWifiHexKey(`${'0123456789abcdef'.repeat(4)}0`)).toBe(false);
	});

	it('is false for 64 characters that are not all hex', () => {
		expect(isWifiHexKey(`${'a'.repeat(63)}z`)).toBe(false);
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

describe('nmcliActivateArgs', () => {
	const uuid = '4b8a1f2c-0000-4000-8000-000000000001';

	it('binds the activation to the device that was edited', () => {
		// Without `ifname`, NetworkManager may bring a generic profile up on any
		// compatible adapter — reconfiguring one interface while leaving the one the
		// user actually edited down.
		expect(nmcliActivateArgs(uuid, 'eth0')).toEqual(['connection', 'up', 'uuid', uuid, 'ifname', 'eth0']);
	});

	it('still addresses the profile by uuid rather than by name', () => {
		const args = nmcliActivateArgs(uuid, 'wlan0');
		expect(args[2]).toBe('uuid');
		expect(args[3]).toBe(uuid);
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

	// The removals above are destructive and irreversible on their own: between
	// them and the last step the interface holds no usable configuration, so a
	// failure in between used to leave the machine with no address, no gateway and
	// no resolvers. Everything the apply overwrites has to be recorded BEFORE the
	// first removal, because afterwards the machine no longer knows what it was.
	it('snapshots the whole IPv4 configuration before the first destructive step', () => {
		for (const config of [{ mode: 'dhcp' } as NetIPv4Config, { mode: 'static', address: '192.0.2.10', prefixLength: 24 } as NetIPv4Config]) {
			const command = windowsApplyIPv4Command(guid, config);
			for (const captured of ['$oldDhcp = ', '$oldAddresses = ', '$oldRoutes = ', '$oldDns = ']) {
				expect(command).toContain(captured);
				expect(command.indexOf(captured)).toBeLessThan(command.indexOf('Remove-NetIPAddress'));
			}
		}
	});

	it('keeps the route metrics in the snapshot, not just the next hops', () => {
		// A hand-set metric is what ranks competing default routes; restoring the
		// route without it silently re-ranks every route on a multi-homed host.
		expect(windowsApplyIPv4Command(guid, { mode: 'dhcp' })).toContain('Select-Object NextHop, RouteMetric');
	});

	it('rolls the snapshot back when any step of the change fails', () => {
		const command = windowsApplyIPv4Command(guid, { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1' });
		// The mutation runs inside a guard, and the guard restores before rethrowing.
		expect(command).toContain('catch { $applyError = $_;');
		expect(command).toContain('throw $applyError');
		expect(command).toContain('foreach ($a in $oldAddresses)');
		expect(command).toContain('foreach ($r in $oldRoutes)');
		expect(command).toContain('$oldDns.Count -gt 0');
		// New-NetIPAddress must be inside the guard, not before it.
		expect(command.indexOf('try { try { Remove-NetIPAddress')).toBeGreaterThan(-1);
	});

	it('restores a DHCP interface by re-enabling DHCP rather than by re-adding its lease', () => {
		// The snapshot addresses of a DHCP interface came from a lease. Writing them
		// back by hand installs a static copy that the next lease then duplicates.
		expect(windowsApplyIPv4Command(guid, { mode: 'static', address: '192.0.2.10', prefixLength: 24 })).toContain("if ($oldDhcp -eq 'Enabled') { Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Enabled } else {");
	});

	it('reports both failures when the rollback itself fails', () => {
		// Neither error alone describes the machine at that point, and answering with
		// only the original one would claim the host was left as it was found.
		expect(windowsApplyIPv4Command(guid, { mode: 'dhcp' })).toContain('and rolling it back also failed');
	});

	it('verifies a static address actually landed before reporting success', () => {
		// PowerShell reports a clean run for a New-NetIPAddress the stack did not
		// honour; without this the apply answers "done" on an interface with no address.
		expect(windowsApplyIPv4Command(guid, { mode: 'static', address: '192.0.2.10', prefixLength: 24 })).toContain("$_.IPAddress -eq '192.0.2.10' })) { throw ");
	});

	it('enables DHCP and resets the resolvers for a DHCP config', () => {
		const command = windowsApplyIPv4Command(guid, { mode: 'dhcp' });
		expect(command).toContain('-Dhcp Enabled');
		expect(command).toContain('-ResetServerAddresses');
		// No address is SET. The rollback still carries a New-NetIPAddress, but that
		// one re-adds `$a.IPAddress` out of the snapshot rather than a literal.
		expect(command).not.toContain('New-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -IPAddress 1');
		expect(command.match(/New-NetIPAddress/g)).toEqual(['New-NetIPAddress']);
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

	it('ignores only a not-found removal, never a real failure', () => {
		// `-ErrorAction SilentlyContinue` treated "already on DHCP, nothing to
		// delete" and "access denied" as the same thing, and the steps after it then
		// ran on an unknown partial state. Verified on Windows 11: a removal that
		// matches nothing reports CategoryInfo.Category of ObjectNotFound, and a
		// genuine failure reports anything but.
		const command = windowsApplyIPv4Command(guid, { mode: 'dhcp' });
		// Only the read-only snapshot queries may be silent — a removal never is.
		expect(command).not.toContain('Remove-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue');
		expect(command).not.toContain("Remove-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' -Confirm:$false -ErrorAction SilentlyContinue");
		expect(command).toContain("catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw } }");
		for (const step of ['Remove-NetIPAddress', 'Remove-NetRoute']) expect(command).toContain(`try { ${step}`);
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

describe('parseNmcliManagedDevices', () => {
	// `nmcli -t -f DEVICE,STATE device status`, colon-separated.
	const STATUS = 'eth0:connected\nwlan0:disconnected\ndocker0:unmanaged\nlo:unmanaged\n';

	it('keeps every device NetworkManager owns, whatever its state', () => {
		const managed = parseNmcliManagedDevices(STATUS);
		expect(managed.has('eth0')).toBe(true);
		expect(managed.has('wlan0')).toBe(true);
	});

	it('drops a device another stack owns, so no edit is offered for it', () => {
		const managed = parseNmcliManagedDevices(STATUS);
		expect(managed.has('docker0')).toBe(false);
	});
});
