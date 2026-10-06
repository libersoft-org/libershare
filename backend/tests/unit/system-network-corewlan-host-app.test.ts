import { afterEach, expect, test } from 'bun:test';
import { setHostApp } from '../../src/native/host-app.ts';
import { assertMacWifiMutationIdle, associateMacWifi, readCoreWlanWifi, scanCoreWlanWifi } from '../../src/system-network-corewlan.ts';

const ssidHex = Buffer.from('Example', 'utf8').toString('hex');
const snapshot = { device: 'en0', interfaceMode: 1, ssidHex: null, bssid: null, securityType: 4, signal: -50, powerOn: true };

afterEach(() => setHostApp(null));

test('state and scan come from the app and are shaped by the shared rules', async () => {
	const requests: unknown[] = [];
	setHostApp(async request => {
		requests.push(JSON.parse(request));
		const network = { ssidHex, bssid: 'aa:bb:cc:dd:ee:ff', securityType: 4, signal: -40 };
		return JSON.stringify({ result: requests.length === 1 ? [{ snapshot: { ...snapshot, ssidHex }, networks: [] }] : { snapshot, networks: [network] } });
	});
	expect(await readCoreWlanWifi()).toEqual([{ device: 'en0', configurable: true, wifi: { ssid: 'Example', signal: 100, radio: 'on' } }]);
	const rows = await scanCoreWlanWifi('en0');
	expect(rows.map(row => [row.ssid, row.bssid, row.security, row.connectable])).toEqual([['Example', 'aa:bb:cc:dd:ee:ff', 'WPA2 Personal', true]]);
	expect(requests).toEqual([{ operation: 'state' }, { operation: 'scan', device: 'en0' }]);
});

test('a read that shows no network while macOS settles keeps the interface configurable', async () => {
	const replies = [
		{ snapshot: { ...snapshot, ssidHex }, networks: [] },
		{ snapshot: { ...snapshot, interfaceMode: 0 }, networks: [] },
	];
	setHostApp(async () => JSON.stringify({ result: [replies.shift()] }));
	expect((await readCoreWlanWifi())[0]!.configurable).toBe(true);
	expect((await readCoreWlanWifi())[0]!.configurable).toBe(true);
});

test('reads made together share one native read instead of one failing as busy', async () => {
	let calls = 0;
	setHostApp(async () => {
		calls++;
		await Bun.sleep(10);
		return JSON.stringify({ result: [{ snapshot: { ...snapshot, ssidHex }, networks: [] }] });
	});
	const [first, second] = await Promise.all([readCoreWlanWifi(), readCoreWlanWifi()]);
	expect(first).toEqual(second);
	expect(calls).toBe(1);
});

test('a scan whose names macOS withheld is refused', async () => {
	setHostApp(async () => JSON.stringify({ result: { snapshot, networks: [{ ssidHex: null, bssid: null, securityType: 4, signal: -40 }] } }));
	await expect(scanCoreWlanWifi('en0')).rejects.toThrow('did not expose Wi-Fi network names');
});

test('the app error reaches the caller and a join blocks further changes until the app answers', async () => {
	let answer!: (reply: string) => void;
	setHostApp(request => {
		expect(JSON.parse(request)).toMatchObject({ operation: 'associate', device: 'en0', ssidHex, securityType: 4, bssid: null });
		return new Promise(resolve => (answer = resolve));
	});
	const join = associateMacWifi('en0', 'Example', 'secret-password', 'WPA2 Personal');
	expect(() => assertMacWifiMutationIdle()).toThrow('still finishing');
	answer(JSON.stringify({ error: 'macOS Wi-Fi association failed (CoreWLAN error -3912)' }));
	await expect(join).rejects.toThrow('CoreWLAN error -3912');
	expect(() => assertMacWifiMutationIdle()).not.toThrow();
});

test('a lost app leaves no request waiting', async () => {
	setHostApp(() => Promise.reject(new Error('The desktop app disconnected')));
	await expect(readCoreWlanWifi()).rejects.toThrow('disconnected');
	expect(() => assertMacWifiMutationIdle()).not.toThrow();
});
