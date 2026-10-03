import { describe, expect, test } from 'bun:test';
import { ptr, type Pointer } from 'bun:ffi';
import { SystemBus, variant, type DBusValue, type DBusSignal } from '../../src/native/linux/dbus.ts';
import { DBUS_LIMITS, dbusCString, decodeDBus } from '../../src/native/linux/dbus-codec.ts';
import { checkSdBus, loadSdBus, nativePointer, type SdBusSymbols } from '../../src/native/linux/dbus-native.ts';

describe.skipIf(process.platform !== 'linux')('real sd-bus', () => {
	test('receives broker signals with an owned sender and body, and unsubscribes', async () => {
		const observer = new SystemBus();
		const signals: DBusSignal[] = [];
		const errors: Error[] = [];
		const subscription = observer.subscribe(
			{ sender: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'NameOwnerChanged' },
			signal => signals.push(signal),
			error => errors.push(error)
		);
		let peer: SystemBus | undefined;
		try {
			peer = new SystemBus();
			const name = peer.uniqueName;
			peer.close();
			const deadline = performance.now() + 2000;
			while (!signals.some(signal => signal.values[0] === name && signal.values[2] === '') && performance.now() < deadline) await Bun.sleep(10);
			expect(signals.filter(signal => signal.values[0] === name).map(signal => signal.values)).toEqual([
				[name, '', name],
				[name, name, ''],
			]);
			expect(signals.find(signal => signal.values[0] === name)).toMatchObject({ type: 'signal', sender: 'org.freedesktop.DBus', signature: 'sss', member: 'NameOwnerChanged' });
			expect(errors).toEqual([]);
			subscription.close();
			const count = signals.length;
			peer = new SystemBus();
			peer.close();
			await Bun.sleep(20);
			expect(signals.length).toBe(count);
		} finally {
			peer?.close();
			subscription.close();
			observer.close();
		}
	});

	test('sealed messages retain NetworkManager variant signatures and owned values', () => {
		const bus = new SystemBus();
		const settings = {
			connection: { id: variant('s', 'Codec test'), autoconnect: variant('b', false), timestamp: variant('t', 1790000000n), 'auth-retries': variant('i', -1) },
			ipv4: { 'address-data': variant('aa{sv}', [{ address: variant('s', '192.0.2.10'), prefix: variant('u', 24) }]), dns: variant('au', [0x350200c0]), 'route-metric': variant('x', -1n) },
			'802-11-wireless': { ssid: variant('ay', new Uint8Array([0, 1, 255, 0x41])), 'seen-bssids': variant('as', []) },
		};
		const cases: [string, DBusValue[]][] = [
			['a{sa{sv}}', [settings]],
			['(ss)aya{su}', [['a', 'b'], new Uint8Array([1, 2, 3]), { k: 7 }]],
			['ao', [[]]],
			['sg', ['', '']],
			[
				'v',
				[
					variant('a(ii)', [
						[1, -2],
						[3, 4],
					]),
				],
			],
			['ynqiuxtdbsog', [255, -32768, 65535, -2147483648, 4294967295, -9223372036854775808n, 18446744073709551615n, 1.25, true, 'Příliš žluťoučký', '/org/example/Test', 'a{sv}']],
			['a{is}', [new Map([[42, 'answer']])]],
			['a{sv}', [JSON.parse('{"__proto__":{"sig":"s","value":"safe"}}') as DBusValue]],
		];
		try {
			for (const [signature, values] of cases) {
				const decoded = bus.roundTrip(signature, values);
				expect(decoded).toEqual(values);
				// A second message can reuse freed native storage; the first result must stay intact.
				bus.roundTrip('s', ['replacement']);
				expect(decoded).toEqual(values);
			}
			expect(() => bus.roundTrip('ay', [new Uint8Array(10001)])).toThrow('array limit');
			expect(() => bus.roundTrip('s', ['x'.repeat(DBUS_LIMITS.bytes)])).toThrow('byte limit');
			expect(() => bus.roundTrip('s', ['nul\0suffix'])).toThrow('NUL');
		} finally {
			bus.close();
		}
	});

	test('copies real reply metadata and rejects failed property reads', async () => {
		const bus = new SystemBus();
		try {
			const request = { kind: 'read' as const, destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'GetId' };
			const reply = await bus.call(request);
			expect(reply.type).toBe('method_return');
			expect(reply.sender).toBe('org.freedesktop.DBus');
			expect(reply.values[0]).toMatch(/^[a-f0-9]{32}$/);
			const missing = await bus.call({ ...request, kind: 'mutation', destination: ':99999999.99999999' });
			expect(missing).toMatchObject({ type: 'error', sender: 'org.freedesktop.DBus', errorName: 'org.freedesktop.DBus.Error.ServiceUnknown' });
			await expect(bus.getAll(':99999999.99999999', '/', 'org.example.Missing')).rejects.toMatchObject({ name: 'DBusError' });
			expect(reply.values[0]).toMatch(/^[a-f0-9]{32}$/);
		} finally {
			bus.close();
		}
	});

	test('rejects incoming oversized arrays, strings and variant nesting', () => {
		const sd = loadSdBus();
		const out = new BigUint64Array(1);
		checkSdBus(sd.sd_bus_open_system(ptr(out)), 'open');
		const bus = nativePointer(out[0]!);
		try {
			withMessage(
				sd,
				bus,
				message => {
					const signature = dbusCString('y');
					checkSdBus(sd.sd_bus_message_open_container(message, 97, ptr(signature)), 'open array');
					const byte = new Uint8Array([7]);
					for (let i = 0; i <= DBUS_LIMITS.arrayElements; i++) checkSdBus(sd.sd_bus_message_append_basic(message, 121, ptr(byte)), 'append');
					checkSdBus(sd.sd_bus_message_close_container(message), 'close array');
				},
				'array limit'
			);
			withMessage(
				sd,
				bus,
				message => {
					const string = Buffer.alloc(DBUS_LIMITS.bytes + 2, 97);
					string[string.length - 1] = 0;
					checkSdBus(sd.sd_bus_message_append_basic(message, 115, ptr(string)), 'append string');
				},
				'byte limit'
			);
			withMessage(
				sd,
				bus,
				message => {
					const string = Buffer.alloc(DBUS_LIMITS.bytes / 2 + 1, 97);
					string[string.length - 1] = 0;
					checkSdBus(sd.sd_bus_message_append_basic(message, 115, ptr(string)), 'append first string');
					checkSdBus(sd.sd_bus_message_append_basic(message, 115, ptr(string)), 'append second string');
				},
				'byte limit'
			);
			withMessage(
				sd,
				bus,
				message => {
					const signature = dbusCString('v');
					for (let i = 0; i < 33; i++) checkSdBus(sd.sd_bus_message_open_container(message, 118, ptr(signature)), 'open variant');
					const inner = dbusCString('s'),
						value = dbusCString('nested');
					checkSdBus(sd.sd_bus_message_open_container(message, 118, ptr(inner)), 'open value variant');
					checkSdBus(sd.sd_bus_message_append_basic(message, 115, ptr(value)), 'append value');
					for (let i = 0; i < 34; i++) checkSdBus(sd.sd_bus_message_close_container(message), 'close variant');
				},
				'nesting limit'
			);
		} finally {
			sd.sd_bus_close_unref(bus);
		}
	});
});

function withMessage(sd: SdBusSymbols, bus: Pointer, append: (message: Pointer) => void, error: string): void {
	const strings = ['/org/libershare/Test', 'org.libershare.Test', 'Data'].map(dbusCString);
	const out = new BigUint64Array(1);
	checkSdBus(sd.sd_bus_message_new_signal(bus, ptr(out), ptr(strings[0]!), ptr(strings[1]!), ptr(strings[2]!)), 'new signal');
	const message = nativePointer(out[0]!);
	try {
		append(message);
		checkSdBus(sd.sd_bus_message_seal(message, 1n, 0n), 'seal');
		checkSdBus(sd.sd_bus_message_rewind(message, 1), 'rewind');
		expect(() => decodeDBus(sd, message)).toThrow(error);
	} finally {
		sd.sd_bus_message_unref(message);
	}
}
