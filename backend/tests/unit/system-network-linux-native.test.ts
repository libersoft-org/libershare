import { describe, expect, test } from 'bun:test';
import { parseNativeIPv4Profile, parseNativeNameservers, readNativeLinuxCapabilities, readNativeLinuxNetwork, scanNativeLinuxWifi } from '../../src/native/linux/network-reader.ts';
import { variant, type DBusVariant } from '../../src/native/linux/dbus.ts';
import { parseLinuxNetworkState } from '../../src/system-network-linux.ts';
import { parseNmcliIPv4Profile, parseNmcliWifiList } from '../helpers/linux-network-oracle.ts';
import capture from './fixtures/native-netlink/arm64.json';
import { createNativeNetworkFixture as fixture, profile } from './fixtures/native-network-reader.ts';

describe('native Linux network snapshot', () => {
	test('captured kernel data and typed NM data preserve the public interface state', async () => {
		const { deps, closed } = fixture();
		const result = await readNativeLinuxNetwork({ timeoutMs: 1000 }, deps);
		const expected = parseLinuxNetworkState({ ...result.sources, nativeWifi: new Map(), iwLinks: new Map([['wlan0', 'Connected to 02:00:00:00:00:01\nSSID: Demo\nsignal: -38 dBm']]), addr: JSON.stringify(capture.getaddr.truth.map(entry => ({ ...entry, ifname: entry.ifindex === 1 ? 'lo' : entry.ifindex === 2 ? 'eth0' : 'wlan0' }))) });
		expect(parseLinuxNetworkState(result.sources)).toEqual(expected);
		expect(expected.map(entry => entry.dns)).toEqual([
			['192.0.2.53', '2001:db8::53'],
			['192.0.2.53', '2001:db8::53'],
		]);
		expect(expected.every(entry => entry.ipv4Mode === 'dhcp' && entry.ipv4Configurable)).toBe(true);
		expect(result.ipv4ProfilesUnavailable).toBe(false);
		expect(closed()).toBe(1);
	});
	test('missing NM preserves nl80211 SSID and attributes resolv.conf only to the default route', async () => {
		const { deps, state } = fixture();
		state.noNm = true;
		const result = await readNativeLinuxNetwork({ timeoutMs: 1000 }, deps);
		const interfaces = parseLinuxNetworkState(result.sources);
		expect(interfaces[0]).toMatchObject({ dns: ['198.51.100.53'], ipv4Configurable: false });
		expect(interfaces[1]).toMatchObject({ dns: [], wifi: { ssid: 'Demo', signal: 100 }, wifiConfigurable: false });
	});
	test('an incomplete profile read disables IPv4 editing without losing device DNS', async () => {
		const { deps, state } = fixture();
		state.failedProfile = true;
		const result = await readNativeLinuxNetwork({ timeoutMs: 1000 }, deps);
		expect(result.ipv4ProfilesUnavailable).toBe(true);
		expect(parseLinuxNetworkState(result.sources).every(entry => !entry.ipv4Configurable && entry.dns.length === 2)).toBe(true);
	});
	test('150 active profiles remain bounded and never read secrets', async () => {
		const { deps, calls } = fixture(150);
		const result = await readNativeLinuxNetwork({ timeoutMs: 1000 }, deps);
		expect(result.sources.ipv4Profiles?.size).toBe(150);
		expect(calls.filter(call => call.member === 'GetSettings')).toHaveLength(150);
		expect(calls.every(call => call.kind === 'read' && call.member !== 'GetSecrets')).toBe(true);
	});
	test('a kernel dump failure rejects instead of reporting an empty network', async () => {
		const { deps } = fixture();
		await expect(
			readNativeLinuxNetwork(
				{ timeoutMs: 1000 },
				{
					...deps,
					netlink: async () => {
						throw new Error('Netlink dump interrupted');
					},
				}
			)
		).rejects.toThrow('interrupted');
	});
	test('carrier EINVAL marks an administratively up link as disconnected', async () => {
		const { deps } = fixture();
		const readFile = (path: string): string => {
			if (path.endsWith('/eth0/carrier')) throw Object.assign(new Error('Interface is down'), { code: 'EINVAL' });
			return path.endsWith('/eth0/operstate') ? 'lowerlayerdown\n' : deps.readFile(path);
		};
		const result = await readNativeLinuxNetwork({ timeoutMs: 1000 }, { ...deps, readFile });
		expect(parseLinuxNetworkState(result.sources)[0]?.link).toBe('down');
	});
	test('a changed NM owner cannot grant capabilities', async () => {
		const { deps, state } = fixture();
		state.ownerChanged = true;
		expect(await readNativeLinuxCapabilities({ timeoutMs: 1000 }, deps)).toEqual({ ipv4: false, wifi: false, staticGatewayRequired: false });
	});
});

describe('typed NetworkManager profile and DNS parity', () => {
	test('omitted defaults are equivalent to nmcli defaults while explicit policy remains read-only', () => {
		const settings = profile('eth0');
		const oracle = 'connection.interface-name:eth0\nconnection.multi-connect:0\nipv4.method:auto\nipv4.never-default:no\nipv4.gateway:\nipv4.addresses:\nipv4.routes:\nipv4.route-table:0\nipv4.routing-rules:';
		expect(parseNativeIPv4Profile(settings, 'eth0', 1)).toEqual(parseNmcliIPv4Profile(oracle, 'eth0', 1));
		settings['ipv4']!['route-table'] = variant('u', 42);
		expect(parseNativeIPv4Profile(settings, 'eth0', 1).safe).toBe(false);
	});
	test('manual address-data agrees with the legacy profile parser', () => {
		const settings = profile('eth0');
		settings['ipv4'] = { method: variant('s', 'manual'), gateway: variant('s', '192.0.2.1'), 'address-data': variant('aa{sv}', [{ address: variant('s', '192.0.2.10'), prefix: variant('u', 24) }]) };
		const oracle = 'connection.interface-name:eth0\nconnection.multi-connect:0\nipv4.method:manual\nipv4.never-default:no\nipv4.gateway:192.0.2.1\nipv4.addresses:192.0.2.10/24';
		expect(parseNativeIPv4Profile(settings, 'eth0', 1)).toEqual(parseNmcliIPv4Profile(oracle, 'eth0', 1));
		expect(parseNativeIPv4Profile(settings, 'eth0', 2).safe).toBe(false);
	});
	test('OVS without IPv4 is legitimate but an ordinary incomplete profile is not', () => {
		const settings = profile('eth0');
		delete settings['ipv4'];
		expect(() => parseNativeIPv4Profile(settings, 'eth0', 1)).toThrow('no IPv4');
		settings['connection']!['type'] = variant('s', 'ovs-bridge');
		expect(parseNativeIPv4Profile(settings, 'eth0', 1)).toMatchObject({ safe: false, method: '' });
	});
	test('legacy DNS byte order is preserved and an empty modern answer is authoritative', () => {
		expect(parseNativeNameservers({ Nameservers: variant('au', [0x350200c0]) }, 4)).toEqual(['192.0.2.53']);
		expect(parseNativeNameservers({ Nameservers: variant('aay', [Buffer.from('20010db8000000000000000000000053', 'hex')]) }, 6)).toEqual(['2001:db8::53']);
		expect(parseNativeNameservers({ NameserverData: variant('aa{sv}', []), Nameservers: variant('au', [0x350200c0]) }, 4)).toEqual([]);
		expect(() => parseNativeNameservers({ NameserverData: variant('aa{sv}', [{ address: variant('s', 'invalid') }]) }, 4)).toThrow('resolver');
	});
});

describe('native Linux capabilities and active scans', () => {
	test('auth permits elevated IPv4 but cannot enable Wi-Fi without an agent', async () => {
		const { deps, state } = fixture();
		expect(await readNativeLinuxCapabilities({ timeoutMs: 1000 }, deps)).toEqual({ ipv4: true, wifi: true, staticGatewayRequired: false });
		state.grant = 'auth';
		expect(await readNativeLinuxCapabilities({ timeoutMs: 1000 }, deps)).toEqual({ ipv4: true, ipv4Elevation: true, wifi: false, staticGatewayRequired: false });
	});
	test('RequestScan waits for LastScan and matches nmcli security and signal output', async () => {
		const { deps, calls, closed } = fixture();
		const result = await scanNativeLinuxWifi('wlan0', { timeoutMs: 1000 }, deps);
		// The native scan adds the raw SSID bytes that nmcli's text cannot carry.
		expect(result).toEqual(parseNmcliWifiList('Demo:02\\:00\\:00\\:00\\:00\\:01:76:WPA2:*\nEnterprise:02\\:00\\:00\\:00\\:00\\:02:60:WPA2 802.1X:').map(row => ({ ...row, ssidHex: Buffer.from(row.ssid).toString('hex') })));
		expect(calls.filter(call => call.member === 'RequestScan')).toHaveLength(1);
		expect(closed()).toBe(1);
	});
	test('a scan without completion times out and closes its own bus', async () => {
		const { deps, state, closed } = fixture();
		state.noScanCompletion = true;
		await expect(scanNativeLinuxWifi('wlan0', { timeoutMs: 20 }, deps)).rejects.toThrow('timed out');
		expect(closed()).toBe(1);
	});
	test('equal-strength access points retain nmcli frequency ordering', async () => {
		const { deps } = fixture();
		const bus = deps.openBus();
		const result = await scanNativeLinuxWifi(
			'wlan0',
			{ timeoutMs: 1000 },
			{
				openBus: () => ({
					close: () => bus.close(),
					call: async request => {
						const reply = await bus.call(request);
						if (request.args?.[0] === 'org.freedesktop.NetworkManager.AccessPoint') {
							const properties = reply.values[0] as Record<string, DBusVariant>;
							properties['Strength'] = variant('y', 0);
							properties['Frequency'] = variant('u', request.path.endsWith('/1') ? 5200 : 2412);
						}
						return reply;
					},
				}),
			}
		);
		expect(result.map(network => network.ssid)).toEqual(['Enterprise', 'Demo']);
	});
});
