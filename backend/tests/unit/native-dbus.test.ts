import { describe, expect, spyOn, test } from 'bun:test';
import { CFunction, CString, FFIType, JSCallback, ptr, toArrayBuffer, type Pointer } from 'bun:ffi';
import { DBusError, DBusTransportError, SystemBus, type DBusRequest, type DBusSignal, type DBusSubscription } from '../../src/native/linux/dbus.ts';
import { splitDBusSignature } from '../../src/native/linux/dbus-codec.ts';
import type { SdBusSymbols } from '../../src/native/linux/dbus-native.ts';

function fakeBus(): {
	sd: SdBusSymbols;
	state: { destination: string; timeout: bigint; slots: number; released: number; calls: number; delivered: boolean; signalReady: boolean; rule: string; failProcess: boolean; sendError: number; insideCallback: boolean; sender: string; errorName: string | null; events: string[]; callbacks: Pointer[]; userdata: Pointer[]; replay: (() => number)[] };
} {
	const buffers: Buffer[] = [];
	const allocate = (value: string | number): Pointer => {
		const buffer = typeof value === 'string' ? Buffer.from(`${value}\0`) : Buffer.alloc(value);
		buffers.push(buffer);
		return ptr(buffer);
	};
	const write = (address: Pointer, value: bigint): void => {
		new DataView(toArrayBuffer(address, 0, 8)).setBigUint64(0, value, true);
	};
	const state = { destination: '', timeout: 0n, slots: 0, released: 0, calls: 0, delivered: false, signalReady: false, rule: '', failProcess: false, sendError: 0, insideCallback: false, sender: ':1.42', errorName: null as string | null, events: [] as string[], callbacks: [] as Pointer[], userdata: [] as Pointer[], replay: [] as (() => number)[] };
	const bus = allocate(8),
		message = allocate(8);
	const callbacks = new Map<Pointer, () => number>();
	const replySenders = new Map<Pointer, string>();
	let signalCallback: (() => number) | undefined;
	const signalSlot = allocate(8);
	const symbols = {
		sd_bus_open_system: (out: Pointer) => {
			write(out, BigInt(bus));
			return 0;
		},
		sd_bus_set_allow_interactive_authorization: () => 0,
		sd_bus_message_new_method_call: (_bus: Pointer, out: Pointer, destination: Pointer) => {
			state.destination = new CString(destination).toString();
			write(out, BigInt(allocate(8)));
			return 0;
		},
		sd_bus_message_unref: () => null,
		sd_bus_call_async: (_bus: Pointer, out: Pointer, _message: Pointer, callbackAddress: Pointer, data: Pointer, timeout: bigint) => {
			state.calls++;
			state.timeout = timeout;
			state.callbacks.push(callbackAddress);
			state.userdata.push(data);
			const invoke = CFunction({ ptr: callbackAddress, args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 });
			replySenders.set(_message, state.sender);
			const callback = () => invoke(_message, data, null);
			state.replay.push(callback);
			if (state.sendError) return -state.sendError;
			const slot = allocate(8);
			write(out, BigInt(slot));
			state.slots++;
			callbacks.set(slot, callback);
			return 1;
		},
		sd_bus_process: () => {
			if (state.failProcess) return -104;
			if (state.signalReady && signalCallback) {
				state.signalReady = false;
				state.insideCallback = true;
				signalCallback();
				state.insideCallback = false;
				return 1;
			}
			const entries = [...callbacks];
			const pending = entries[entries.length - 1];
			if (!state.delivered || !pending) return 0;
			state.insideCallback = true;
			state.events.push('callback-enter');
			pending[1]();
			state.events.push('callback-exit');
			state.insideCallback = false;
			callbacks.delete(pending[0]);
			return 1;
		},
		sd_bus_slot_unref: (releasedSlot: Pointer) => {
			if (state.insideCallback) throw new Error('Released slot inside callback');
			state.events.push('slot-unref');
			state.slots--;
			state.released++;
			if (releasedSlot === signalSlot) signalCallback = undefined;
			else callbacks.delete(releasedSlot);
			return null;
		},
		sd_bus_close_unref: () => {
			state.events.push('bus-close');
			return null;
		},
		sd_bus_message_get_type: (_message: Pointer, out: Pointer) => {
			new Uint8Array(toArrayBuffer(out, 0, 1))[0] = state.errorName ? 3 : 2;
			return 0;
		},
		sd_bus_message_get_sender: (reply: Pointer) => allocate(replySenders.get(reply) ?? state.sender),
		sd_bus_message_get_path: () => allocate('/org/example/Service'),
		sd_bus_message_get_interface: () => allocate('org.example.Service'),
		sd_bus_message_get_member: () => allocate('Changed'),
		sd_bus_add_match: (_bus: Pointer, out: Pointer, rule: Pointer, address: Pointer, data: Pointer) => {
			state.rule = new CString(rule).toString();
			write(out, BigInt(signalSlot));
			state.slots++;
			const invoke = CFunction({ ptr: address, args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 });
			state.callbacks.push(address);
			state.userdata.push(data);
			signalCallback = () => invoke(message, data, null);
			return 0;
		},
		sd_bus_message_get_signature: () => allocate(''),
		sd_bus_message_get_error: () => {
			if (!state.errorName) return null;
			const error = allocate(24);
			write(error, BigInt(allocate(state.errorName)));
			write((error + 8) as Pointer, BigInt(allocate('Rejected')));
			return error;
		},
		sd_bus_message_peek_type: () => 0,
	};
	return { sd: symbols as unknown as SdBusSymbols, state };
}

const method: DBusRequest = { kind: 'read', destination: ':1.42', path: '/org/example/Service', interface: 'org.example.Service', member: 'Read' };
const match = { sender: ':1.42', path: '/org/example/Service', interface: 'org.example.Service', member: 'Changed' };

describe('sd-bus subscriptions', () => {
	test('delivers an early signal before resolving the method reply', async () => {
		const { sd, state } = fakeBus();
		const bus = new SystemBus({}, sd);
		const received: DBusSignal[] = [];
		const errors: Error[] = [];
		const subscription = bus.subscribe(
			match,
			signal => received.push(signal),
			error => errors.push(error)
		);
		try {
			expect(state.rule).toBe("type='signal',sender=':1.42',path='/org/example/Service',interface='org.example.Service',member='Changed'");
			state.signalReady = true;
			state.delivered = true;
			await bus.call(method);
			expect(received).toEqual([{ ...match, type: 'signal', signature: '', values: [] }]);
			expect(errors).toEqual([]);
			expect(state.slots).toBe(1);
		} finally {
			subscription.close();
			bus.close();
		}
		expect(state.slots).toBe(0);
	});

	test('listener can unsubscribe, close the bus or throw without freeing a live callback', async () => {
		for (const action of ['unsubscribe', 'close', 'throw'] as const) {
			const { sd, state } = fakeBus();
			const bus = new SystemBus({}, sd);
			let subscription: DBusSubscription;
			let delivered = false;
			const errors: Error[] = [];
			subscription = bus.subscribe(
				match,
				() => {
					expect(state.insideCallback).toBe(false);
					delivered = true;
					if (action === 'unsubscribe') subscription.close();
					if (action === 'close') bus.close();
					if (action === 'throw') throw new Error('listener failed');
				},
				error => errors.push(error)
			);
			state.signalReady = true;
			try {
				await Bun.sleep(30);
				expect(delivered).toBe(true);
				expect(state.slots).toBe(0);
				expect(state.released).toBe(1);
				expect(errors.map(error => error.message)).toEqual(action === 'throw' ? ['listener failed'] : []);
			} finally {
				bus.close();
			}
		}
	});

	test('transport failure closes subscriptions and reports the failure', async () => {
		const { sd, state } = fakeBus();
		const bus = new SystemBus({}, sd);
		const errors: Error[] = [];
		bus.subscribe(
			match,
			() => {
				throw new Error('unexpected signal');
			},
			error => errors.push(error)
		);
		state.failProcess = true;
		try {
			await Bun.sleep(30);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatchObject({ stage: 'process', mayHaveBeenSent: true });
			expect(state.slots).toBe(0);
			await expect(bus.call(method)).rejects.toMatchObject({ stage: 'before-send' });
		} finally {
			bus.close();
		}
	});
});

describe('D-Bus signatures', () => {
	test('splits nested settings, structs, object paths and arrays', () => {
		expect(splitDBusSignature('a{sa{sv}}(ss)ayao')).toEqual(['a{sa{sv}}', '(ss)', 'ay', 'ao']);
	});
	test('rejects incomplete, invalid and unbounded signatures', () => {
		for (const signature of ['a', '(', '()', '{sv}', 'a{vv}', 'a{s}', 'a{sss}', ')', 'z', 'h', 'a'.repeat(33) + 'i', 's'.repeat(256)]) expect(() => splitDBusSignature(signature)).toThrow();
	});
});

describe('sd-bus call lifetime', () => {
	test('one trampoline routes reverse replies across calls and connections', async () => {
		const first = fakeBus(), second = fakeBus();
		const firstBus = new SystemBus({}, first.sd), secondBus = new SystemBus({}, second.sd);
		const order: string[] = [];
		try {
			first.state.sender = ':1.41';
			const a = firstBus.call(method).then(reply => { expect(reply.sender).toBe(':1.41'); order.push('a'); });
			first.state.sender = ':1.42';
			const b = firstBus.call(method).then(reply => { expect(reply.sender).toBe(':1.42'); order.push('b'); });
			second.state.sender = ':1.43';
			const c = secondBus.call(method).then(reply => { expect(reply.sender).toBe(':1.43'); order.push('c'); });
			expect(new Set([...first.state.callbacks, ...second.state.callbacks]).size).toBe(1);
			expect(new Set([...first.state.userdata, ...second.state.userdata]).size).toBe(3);
			second.state.delivered = true;
			await c;
			first.state.delivered = true;
			await Promise.all([a, b]);
			// Results settle after the pump; each callback still reaches its own promise.
			expect(order[0]).toBe('c');
			expect(new Set(order)).toEqual(new Set(['a', 'b', 'c']));
			expect(first.state.released).toBe(2);
			expect(second.state.released).toBe(1);
		} finally {
			firstBus.close(); secondBus.close();
		}
	});
	test('cancellation removes only its userdata while other calls remain pending', async () => {
		const { sd, state } = fakeBus();
		const bus = new SystemBus({}, sd);
		const controller = new AbortController();
		let completed = false;
		try {
			const cancelled = bus.call({ ...method, signal: controller.signal });
			const pending = bus.call(method).then(() => { completed = true; });
			controller.abort();
			await expect(cancelled).rejects.toMatchObject({ stage: 'cancelled', mayHaveBeenSent: true });
			expect(state.slots).toBe(1);
			expect(state.replay[0]!()).toBe(0);
			await Bun.sleep(10);
			expect(completed).toBe(false);
			state.delivered = true;
			await pending;
			expect(state.slots).toBe(0);
		} finally { bus.close(); }
	});
	test('closed connections and subscriptions keep reusing the worker trampoline', async () => {
		const addresses = new Set<Pointer>();
		for (let i = 0; i < 20; i++) {
			const { sd, state } = fakeBus();
			const bus = new SystemBus({}, sd);
			bus.subscribe(match, () => {}, error => { throw error; });
			state.delivered = true;
			try { await bus.call(method); }
			finally { bus.close(); }
			for (const address of state.callbacks) addresses.add(address);
			expect(state.slots).toBe(0);
		}
		expect(addresses.size).toBe(1);
	});
	test('pins mutation destination and waits without a local timeout', async () => {
		const { sd, state } = fakeBus();
		const bus = new SystemBus({}, sd);
		const originalClose = JSCallback.prototype.close;
		const callbackClose = spyOn(JSCallback.prototype, 'close').mockImplementation(function (this: JSCallback): void {
			expect(state.insideCallback).toBe(false);
			expect(state.slots).toBe(0);
			state.events.push('callback-close');
			originalClose.call(this);
		});
		try {
			const call = bus.call({ ...method, kind: 'mutation' });
			expect(state.timeout).toBe(0xffffffffffffffffn);
			expect(state.destination).toBe(':1.42');
			await Bun.sleep(25);
			expect(state.slots).toBe(1);
			state.delivered = true;
			expect(await call).toMatchObject({ sender: ':1.42', type: 'method_return', values: [] });
			expect(state.events).toEqual(['callback-enter', 'callback-exit', 'slot-unref']);
			expect(callbackClose).not.toHaveBeenCalled();
			expect(state.released).toBe(1);
			expect(state.calls).toBe(1);
		} finally {
			bus.close();
			callbackClose.mockRestore();
		}
	});
	test('rejects well-known mutation destinations and unbounded reads before sending', async () => {
		const { sd, state } = fakeBus();
		const bus = new SystemBus({}, sd);
		try {
			for (const destination of ['org.example.Service', ':missingDot', ':1.42\0', `:1.${'x'.repeat(253)}`]) await expect(bus.call({ ...method, kind: 'mutation', destination })).rejects.toMatchObject({ stage: 'before-send', mayHaveBeenSent: false });
			await expect(bus.call({ ...method, timeoutUsec: 0n })).rejects.toMatchObject({ stage: 'before-send' });
			await expect(bus.call({ ...method, timeoutUsec: 0xffffffffffffffffn })).rejects.toMatchObject({ stage: 'before-send' });
			expect(state.calls).toBe(0);
		} finally {
			bus.close();
		}
	});
	test('preserves authentic service errors and bus errors separately', async () => {
		for (const sender of [':1.42', 'org.freedesktop.DBus']) {
			const { sd, state } = fakeBus();
			state.sender = sender;
			state.errorName = 'org.freedesktop.DBus.Error.NoReply';
			state.delivered = true;
			const bus = new SystemBus({}, sd);
			try {
				const reply = await bus.call(method);
				expect(reply).toMatchObject({ sender, type: 'error', errorName: state.errorName, errorMessage: 'Rejected' });
				expect(new DBusError(reply).reply).toBe(reply);
			} finally {
				bus.close();
			}
		}
	});
	test('transport loss and explicit close leave a sent mutation uncertain', async () => {
		for (const action of ['disconnect', 'close'] as const) {
			const { sd, state } = fakeBus();
			const bus = new SystemBus({}, sd);
			const call = bus.call({ ...method, kind: 'mutation' });
			if (action === 'disconnect') state.failProcess = true;
			else bus.close();
			await expect(call).rejects.toMatchObject({ stage: action === 'disconnect' ? 'process' : 'closed', mayHaveBeenSent: true });
			bus.close();
			expect(state.slots).toBe(0);
			expect(state.released).toBe(1);
			expect(state.calls).toBe(1);
		}
	});
	test('read cancellation releases its slot without claiming remote cancellation', async () => {
		const { sd, state } = fakeBus();
		const bus = new SystemBus({}, sd);
		const controller = new AbortController();
		try {
			const call = bus.call({ ...method, signal: controller.signal });
			controller.abort();
			await expect(call).rejects.toMatchObject({ stage: 'cancelled', mayHaveBeenSent: true });
			expect(state.slots).toBe(0);
			await expect(bus.call({ ...method, signal: controller.signal })).rejects.toMatchObject({ stage: 'before-send', mayHaveBeenSent: false });
			expect(state.calls).toBe(1);
		} finally {
			bus.close();
		}
	});
	test('negative call_async returns reject unsent mutations and release callbacks without retry', async () => {
		// ENOTCONN and ECONNRESET are unsent here; process-time ECONNRESET remains uncertain above.
		for (const errno of [107, 104]) {
			const { sd, state } = fakeBus();
			state.sendError = errno;
			const bus = new SystemBus({}, sd);
			const callbackClose = spyOn(JSCallback.prototype, 'close');
			try {
				const call = bus.call({ ...method, kind: 'mutation' });
				await expect(call).rejects.toBeInstanceOf(DBusTransportError);
				await expect(call).rejects.toMatchObject({ stage: 'before-send', mayHaveBeenSent: false, errno });
				expect(state.calls).toBe(1);
				expect(state.slots).toBe(0);
				expect(state.released).toBe(0);
				expect(callbackClose).not.toHaveBeenCalled();
				expect(state.replay[0]!()).toBe(0);
			} finally {
				bus.close();
				callbackClose.mockRestore();
			}
		}
	});
});
