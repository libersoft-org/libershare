import { expect, test } from 'bun:test';
import { WifiSecretAgent, type WifiSecretScope } from '../../src/native/linux/wifi-secret-agent.ts';
import { variant, type DBusMethodCall, type DBusMethodResponse, type DBusReply, type DBusRequest } from '../../src/native/linux/dbus.ts';

const OWNER = ':1.42';
const IFACE = 'org.freedesktop.NetworkManager.SecretAgent';
const SETTING = '802-11-wireless-security';
const scope: WifiSecretScope = { profilePath: '/org/freedesktop/NetworkManager/Settings/7', uuid: '00000000-0000-4000-8000-000000000001', ssidHex: Buffer.from('Demo').toString('hex'), authentication: 'wpa-psk', password: 'entered-demo-password' };

function getSecrets(flags = 5): DBusMethodCall {
	return { sender: OWNER, interface: IFACE, member: 'GetSecrets', signature: 'a{sa{sv}}osasu', values: [{ connection: { uuid: variant('s', scope.uuid), type: variant('s', '802-11-wireless') }, '802-11-wireless': { ssid: variant('ay', Buffer.from('Demo')) }, [SETTING]: { 'key-mgmt': variant('s', 'wpa-psk') } }, scope.profilePath, SETTING, [], flags] };
}

function fixture() {
	let receive!: (request: DBusMethodCall) => DBusMethodResponse;
	let close!: () => void;
	const sent: DBusRequest[] = [];
	const agent = new WifiSecretAgent(
		{
			call: async request => {
				sent.push(request);
				return { type: 'method_return', sender: OWNER, signature: '', values: [], errorName: null, errorMessage: null } satisfies DBusReply;
			},
			exportObject: (_path, _sender, handler, onClose) => {
				receive = handler;
				close = () => onClose?.();
				return { close };
			},
		},
		OWNER,
		scope
	);
	return { agent, sent, request: (request: DBusMethodCall) => receive(request), disconnect: () => close() };
}

test('an interactive password is not consumed by a stored-secret lookup', () => {
	const f = fixture();
	try {
		expect(f.request(getSecrets(0))).toMatchObject({ errorName: `${IFACE}.NoSecrets` });
		expect(f.request(getSecrets(7))).toEqual({ signature: 'a{sa{sv}}', args: [{ [SETTING]: { psk: variant('s', scope.password) } }] });
		expect(f.request(getSecrets(7))).toMatchObject({ errorName: `${IFACE}.UserCanceled` });
	} finally {
		f.agent.close();
	}
});

test('another owner, profile, SSID, setting or authentication cannot obtain the password', () => {
	const requests = [getSecrets(), getSecrets(), getSecrets(), getSecrets(), getSecrets()];
	requests[0] = { ...requests[0]!, sender: ':1.99' };
	requests[1]!.values[1] = '/org/freedesktop/NetworkManager/Settings/8';
	(requests[2]!.values[0] as any).connection.uuid = variant('s', 'another-profile');
	(requests[3]!.values[0] as any)['802-11-wireless'].ssid = variant('ay', Buffer.from('Other'));
	requests[4]!.values[2] = '802-1x';
	const changedAuthentication = getSecrets();
	(changedAuthentication.values[0] as any)[SETTING]['key-mgmt'] = variant('s', 'sae');
	requests.push(changedAuthentication);
	for (const request of requests) {
		const f = fixture();
		try {
			expect(f.request(request)).toMatchObject({ errorName: `${IFACE}.NoSecrets` });
			expect(f.request(getSecrets())).toHaveProperty('args');
		} finally {
			f.agent.close();
		}
	}
});

test('save, delete and cancel remain restricted to the same owner and profile', () => {
	for (const member of ['SaveSecrets', 'DeleteSecrets', 'CancelGetSecrets']) {
		const f = fixture();
		const request: DBusMethodCall = member === 'CancelGetSecrets' ? { sender: OWNER, interface: IFACE, member, signature: 'os', values: [scope.profilePath, SETTING] } : { ...getSecrets(), member, signature: 'a{sa{sv}}o', values: getSecrets().values.slice(0, 2) };
		try {
			expect(f.request({ ...request, sender: ':1.99' })).toMatchObject({ errorName: `${IFACE}.NoSecrets` });
			expect(f.request(request)).toEqual({ signature: '', args: [] });
			request.values[member === 'CancelGetSecrets' ? 0 : 1] = '/org/freedesktop/NetworkManager/Settings/9';
			expect(f.request(request)).toMatchObject({ errorName: `${IFACE}.NoSecrets` });
		} finally {
			f.agent.close();
		}
	}
});

test('registration is bound to NM and closing the export revokes credentials', async () => {
	const f = fixture();
	await f.agent.register();
	expect(f.sent[0]).toMatchObject({ kind: 'mutation', destination: OWNER, member: 'RegisterWithCapabilities', signature: 'su' });
	await f.agent.unregister();
	expect(f.sent[1]).toMatchObject({ destination: OWNER, member: 'Unregister' });
	f.disconnect();
	expect(f.request(getSecrets())).toMatchObject({ errorName: `${IFACE}.NoSecrets` });
	f.agent.close();
});
