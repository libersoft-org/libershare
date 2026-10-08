import type { NativeNetworkReaderDeps } from '../../../src/native/linux/network-reader.ts';
import { variant, type DBusRequest, type DBusReply, type DBusVariant, type DBusValue } from '../../../src/native/linux/dbus.ts';
import { decodeNetlinkAddresses, decodeNetlinkRoutes } from '../../../src/native/linux/netlink.ts';
import { decodeNetlinkDump } from '../../../src/native/linux/netlink-wire.ts';
import capture from './native-netlink/arm64.json';

const NM = 'org.freedesktop.NetworkManager';
const ROOT = '/org/freedesktop/NetworkManager';
type Properties = Record<string, DBusVariant>;

export function profile(device: string, uuid = 'profile-1'): Record<string, Properties> {
	return { connection: { uuid: variant('s', uuid), type: variant('s', '802-3-ethernet'), 'interface-name': variant('s', device) }, ipv4: { method: variant('s', 'auto') } };
}

export function createNativeNetworkFixture(count: number = 2): {
	deps: NativeNetworkReaderDeps;
	state: { noNm: boolean; failedProfile: boolean; noScanCompletion: boolean; grant: string; ownerChanged: boolean; ovs: boolean; malformedProfile: boolean };
	calls: DBusRequest[];
	closed: () => number;
} {
	const calls: DBusRequest[] = [];
	let closed = 0,
		scanRequested = false;
	const state = { noNm: false, failedProfile: false, noScanCompletion: false, grant: 'yes', ownerChanged: false, ovs: false, malformedProfile: false };
	const devices = Array.from({ length: count }, (_, i) => `${ROOT}/Devices/${i + 1}`);
	const active = devices.map((_, i) => `${ROOT}/ActiveConnection/${i + 1}`);
	const names = devices.map((_, i) => (i === 1 ? 'wlan0' : `eth${i}`));
	const reply = (signature: string, value: DBusValue): DBusReply => ({ type: 'method_return', sender: state.ownerChanged ? ':1.99' : ':1.42', signature, values: [value], errorName: null, errorMessage: null });
	const error = (name: string): DBusReply => ({ type: 'error', sender: 'org.freedesktop.DBus', signature: '', values: [], errorName: name, errorMessage: 'Unavailable' });
	const call = async (request: DBusRequest): Promise<DBusReply> => {
		calls.push(request);
		if (request.member === 'GetNameOwner') return state.noNm ? error('org.freedesktop.DBus.Error.NameHasNoOwner') : reply('s', ':1.42');
		if (request.member === 'GetPermissions') return reply('a{ss}', Object.fromEntries(['settings.modify.system', 'network-control', 'checkpoint-rollback', 'wifi.scan'].map(name => [`${NM}.${name}`, state.grant])));
		if (request.member === 'GetDeviceByIpIface') return reply('o', devices[1]!);
		if (request.member === 'RequestScan') {
			scanRequested = true;
			return { ...reply('', ''), values: [] };
		}
		if (request.member === 'GetSettings') {
			if (state.failedProfile) return error('org.freedesktop.DBus.Error.AccessDenied');
			const index = Number(request.path.split('/').pop()) - 1;
			const settings = profile(names[index]!, `profile-${index + 1}`);
			if (index === 1 && state.ovs) {
				delete settings['ipv4'];
				settings['connection']!['type'] = variant('s', 'ovs-bridge');
			}
			if (index === 0 && state.malformedProfile) delete settings['ipv4']!['method'];
			return reply('a{sa{sv}}', settings);
		}
		if (request.member !== 'GetAll') throw new Error(`Unexpected method ${request.member}`);
		const iface = request.args?.[0];
		if (request.path === ROOT) return reply('a{sv}', { State: variant('u', 70), Devices: variant('ao', devices), ActiveConnections: variant('ao', active) });
		const index = Number(request.path.split('/').pop()) - 1;
		if (iface === `${NM}.Device`) return reply('a{sv}', { Interface: variant('s', index === 1 && state.ovs ? 'ovs0' : names[index]!), Managed: variant('b', true), Ip4Config: variant('o', `${ROOT}/IP4Config/${index + 1}`), Ip6Config: variant('o', `${ROOT}/IP6Config/${index + 1}`) });
		if (iface === `${NM}.IP4Config`) return reply('a{sv}', { NameserverData: variant('aa{sv}', [{ address: variant('s', '192.0.2.53') }]) });
		if (iface === `${NM}.IP6Config`) return reply('a{sv}', { NameserverData: variant('aa{sv}', [{ address: variant('s', '2001:db8::53') }]) });
		if (iface === `${NM}.Connection.Active`) return reply('a{sv}', { Uuid: variant('s', `profile-${index + 1}`), Devices: variant('ao', [devices[index]!]), Connection: variant('o', `${ROOT}/Settings/${index + 1}`) });
		if (iface === `${NM}.Device.Wireless`) return reply('a{sv}', { LastScan: variant('x', scanRequested && !state.noScanCompletion ? 1n : 0n), AccessPoints: variant('ao', [`${ROOT}/AccessPoint/1`, `${ROOT}/AccessPoint/2`]), ActiveAccessPoint: variant('o', `${ROOT}/AccessPoint/1`) });
		if (iface === `${NM}.AccessPoint`) return reply('a{sv}', { Ssid: variant('ay', Buffer.from(index === 0 ? 'Demo' : 'Enterprise')), HwAddress: variant('s', `02:00:00:00:00:0${index + 1}`), Strength: variant('y', index === 0 ? 76 : 60), Frequency: variant('u', 2412), MaxBitrate: variant('u', 54000), Flags: variant('u', 1), WpaFlags: variant('u', 0), RsnFlags: variant('u', index === 0 ? 0x188 : 0x288) });
		throw new Error(`Unexpected interface ${String(iface)}`);
	};
	const namesByIndex = new Map([
		[1, 'lo'],
		[2, 'eth0'],
		[3, 'wlan0'],
	]);
	const messages = (raw: string[]) =>
		decodeNetlinkDump(
			raw.map(value => Buffer.from(value, 'base64')),
			capture.sequence
		);
	const deps: NativeNetworkReaderDeps = {
		openBus: () => ({
			call,
			close: () => {
				closed++;
			},
		}),
		netlink: async () => ({ links: [...namesByIndex].map(([ifindex, name]) => ({ ifindex, ifname: name === 'wlan0' && state.ovs ? 'ovs0' : name, operstate: 'UP', flags: ['UP', 'LOWER_UP'], link_type: name === 'lo' ? 'loopback' : 'ether' })), addresses: decodeNetlinkAddresses(messages(capture.getaddr.raw)), routes4: decodeNetlinkRoutes(messages(capture.getroute4.raw), namesByIndex), routes6: decodeNetlinkRoutes(messages(capture.getroute6.raw), namesByIndex) }),
		wifiLink: async () => ({ ssid: 'Demo', bssid: '02:00:00:00:00:01', signal: -38 }),
		readFile: path => (path.endsWith('/operstate') ? 'up\n' : path.endsWith('/carrier') ? '1\n' : path === '/etc/resolv.conf' ? 'nameserver 198.51.100.53\n' : ''),
		realpath: path => (path.endsWith('/lo') ? '/sys/devices/virtual/net/lo' : `/sys/devices/pci0000/${path.split('/').pop()}`),
		exists: path => (path.endsWith('/operstate') ? !path.includes('bonding_masters') : path.endsWith('/wlan0/phy80211')),
		listLinks: () => ['lo', 'eth0', state.ovs ? 'ovs0' : 'wlan0', 'bonding_masters'],
	};
	return { deps, state, calls, closed: () => closed };
}
