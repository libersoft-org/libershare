import { describe, expect, it } from 'bun:test';
import { CFunction, FFIType, ptr, type Pointer } from 'bun:ffi';
import { linuxVolume, type LinuxVolumeBackends } from '../../src/native/linux/pulse-volume.ts';
import { PulseSession, PulseTimeout } from '../../src/native/linux/pulse.ts';
import type { PulseSymbols } from '../../src/native/linux/pulse-native.ts';

function pulseFixture(state = 4, success = true, advance = true): { api: PulseSymbols; calls: string[]; fire: (event: number) => void } {
	const calls: string[] = [];
	const name = Buffer.from('default-sink\0');
	const info = Buffer.alloc(320);
	info.writeBigUInt64LE(BigInt(ptr(name)), 48);
	info[172] = 2;
	info.writeUInt32LE(Math.round(65536 * 0.2), 176);
	info.writeUInt32LE(Math.round(65536 * 0.8), 180);
	const queue: (() => void)[] = [];
	let operation = 0;
	let subscribed: Pointer | null = null;
	const invoke = (callback: Pointer, types: FFIType[], values: unknown[]): void => {
		const fn = CFunction({ ptr: callback, args: types, returns: FFIType.void });
		try {
			fn(...values);
		} finally {
			fn.close();
		}
	};
	const api = {
		pa_mainloop_new: () => 1,
		pa_mainloop_get_api: () => 2,
		pa_context_new: () => 3,
		pa_context_connect: () => 0,
		pa_context_get_state: () => state,
		pa_mainloop_iterate: () => {
			if (advance) queue.shift()?.();
			return 0;
		},
		pa_context_get_server_info: (_c: unknown, cb: Pointer) => {
			operation = 0;
			queue.push(() => {
				invoke(cb, [FFIType.ptr, FFIType.ptr, FFIType.ptr], [null, ptr(info), null]);
				operation = 1;
			});
			return 4;
		},
		pa_context_get_sink_info_by_name: (_c: unknown, _n: unknown, cb: Pointer) => {
			operation = 0;
			queue.push(() => {
				invoke(cb, [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr], [null, ptr(info), 0, null]);
				invoke(cb, [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr], [null, null, 1, null]);
				operation = 1;
			});
			return 4;
		},
		pa_context_set_sink_volume_by_name: (_c: unknown, _n: unknown, _v: unknown, cb: Pointer) => {
			operation = 0;
			queue.push(() => {
				invoke(cb, [FFIType.ptr, FFIType.i32, FFIType.ptr], [null, success ? 1 : 0, null]);
				operation = 1;
			});
			return 4;
		},
		pa_context_set_state_callback: () => {
			calls.push('unset-state');
		},
		pa_context_set_subscribe_callback: (_c: unknown, cb: Pointer | null) => {
			subscribed = cb;
			if (!cb) calls.push('unset-subscribe');
		},
		pa_context_subscribe: (_c: unknown, mask: number, cb: Pointer) => {
			expect(mask).toBe(129);
			operation = 0;
			queue.push(() => {
				invoke(cb, [FFIType.ptr, FFIType.i32, FFIType.ptr], [null, 1, null]);
				operation = 1;
			});
			return 4;
		},
		pa_operation_get_state: () => operation,
		pa_operation_cancel: () => {
			calls.push('cancel');
			operation = 2;
		},
		pa_operation_unref: () => {
			calls.push('unref-operation');
		},
		pa_context_disconnect: () => {
			calls.push('disconnect');
		},
		pa_context_unref: () => {
			calls.push('unref-context');
		},
		pa_mainloop_free: () => {
			calls.push('free-loop');
		},
		pa_cvolume_set: () => null,
	} as unknown as PulseSymbols;
	return {
		api,
		calls,
		fire: event => {
			if (subscribed) invoke(subscribed, [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], [null, event, 0, null]);
		},
	};
}

describe('native Linux volume', () => {
	it('reads first channel rather than average and awaits a successful write callback', async () => {
		const fixture = pulseFixture(4, false),
			session = new PulseSession(fixture.api);
		try {
			expect((await session.sink(performance.now() + 1000)).volume).toBe(20);
			await expect(session.write(37, performance.now() + 1000)).rejects.toThrow('Pulse operation failed');
		} finally {
			session.close();
		}
	});
	it('subscribes to sink and server changes, and never emits after stop', async () => {
		const fixture = pulseFixture(),
			session = new PulseSession(fixture.api);
		let count = 0;
		await session.subscribe(() => {
			count++;
		}, performance.now() + 1000);
		fixture.fire(0x10);
		fixture.fire(0x17);
		fixture.fire(0x12);
		expect(count).toBe(2);
		session.close();
		fixture.fire(0x10);
		expect(count).toBe(2);
	});
	it('closes FAILED without waiting for TERMINATED and only frees once', async () => {
		const fixture = pulseFixture(5),
			session = new PulseSession(fixture.api);
		await expect(session.ready(performance.now() + 1000)).rejects.toThrow('Pulse connection lost');
		session.close();
		session.close();
		expect(fixture.calls).toEqual(['unset-state', 'unset-subscribe', 'disconnect', 'unref-context', 'free-loop']);
	});
	it('unregisters and cancels outstanding operations before freeing a stopped context', async () => {
		const fixture = pulseFixture(4, true, false);
		const session = new PulseSession(fixture.api);
		const read = session.sink(performance.now() + 1000);
		session.close();
		await expect(read).rejects.toThrow('Pulse session stopped');
		expect(fixture.calls).toEqual(['unset-state', 'unset-subscribe', 'cancel', 'unref-operation', 'disconnect', 'unref-context', 'free-loop']);
	});
	it('falls back on every definitive failure and missing usable volume', async () => {
		for (const failure of ['NOENTITY', 'INVALID', 'connect', 'library', 'empty']) {
			let count = 0;
			const deps: LinuxVolumeBackends = {
				pulse: async () => {
					if (failure === 'empty') return NaN;
					throw new Error(failure);
				},
				alsa: () => {
					count++;
					return { kind: 'ok', volume: 42 };
				},
				now: () => 0,
			};
			expect(await linuxVolume({ timeoutMs: 5000 }, undefined, deps)).toEqual({ kind: 'ok', volume: 42 });
			expect(count).toBe(1);
		}
	});
	it('never starts ALSA after the shared budget expires', async () => {
		let now = 0,
			count = 0;
		const deps: LinuxVolumeBackends = {
			pulse: async () => {
				now = 5000;
				throw new PulseTimeout();
			},
			alsa: () => {
				count++;
				return { kind: 'no-device' };
			},
			now: () => now,
		};
		expect(await linuxVolume({ timeoutMs: 5000 }, undefined, deps)).toEqual({ kind: 'error' });
		expect(count).toBe(0);
	});
});
