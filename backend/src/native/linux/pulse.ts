import { CString, FFIType, JSCallback, ptr, read, type Pointer } from 'bun:ffi';
import { loadPulse, type PulseSymbols } from './pulse-native.ts';

export class PulseTimeout extends Error {}
export interface PulseSink {
	name: string;
	channels: number;
	volume: number;
}

/** Callbacks run only inside this worker's nonblocking mainloop iteration. */
export class PulseSession {
	private readonly api: PulseSymbols;
	private loop: Pointer | null = null;
	private context: Pointer | null = null;
	private readonly callbacks = new Set<JSCallback>();
	private readonly operations = new Set<Pointer>();
	private stopped = false;
	constructor(api: PulseSymbols = loadPulse()) {
		this.api = api;
		try {
			this.loop = (Number(api.pa_mainloop_new()) as Pointer) || null;
			if (!this.loop) throw new Error('Pulse mainloop unavailable');
			const name = Buffer.from('LiberShare\0');
			this.context = (Number(api.pa_context_new(api.pa_mainloop_get_api(this.loop), ptr(name))) as Pointer) || null;
			if (!this.context || api.pa_context_connect(this.context, null, 0, null) < 0) throw new Error('Pulse connection failed');
		} catch (error) {
			this.close();
			throw error;
		}
	}
	private callback(fn: (...args: number[]) => void, args: readonly FFIType[]): JSCallback {
		const callback = new JSCallback(
			(...values: number[]) => {
				if (!this.stopped) fn(...values);
			},
			{ args: [...args], returns: FFIType.void }
		);
		this.callbacks.add(callback);
		return callback;
	}
	private release(callback: JSCallback): void {
		if (this.callbacks.delete(callback)) callback.close();
	}
	iterate(): void {
		if (this.stopped || !this.context || !this.loop) throw new Error('Pulse session stopped');
		if (this.api.pa_mainloop_iterate(this.loop, 0, null) < 0 || this.api.pa_context_get_state(this.context) >= 5) throw new Error('Pulse connection lost');
	}
	private async wait(complete: () => boolean, deadline: number): Promise<void> {
		while (true) {
			if (this.stopped) throw new Error('Pulse session stopped');
			if (complete()) return;
			if (performance.now() >= deadline) throw new PulseTimeout('Pulse deadline exhausted');
			this.iterate();
			if (!complete()) await new Promise<void>(resolve => setTimeout(resolve, 5));
		}
	}
	async ready(deadline: number): Promise<void> {
		await this.wait(() => this.api.pa_context_get_state(this.context) === 4, deadline);
	}
	private async operation(value: Pointer | bigint | null, successful: () => boolean, deadline: number): Promise<void> {
		const operation = Number(value) as Pointer;
		if (!operation) throw new Error('Pulse operation unavailable');
		this.operations.add(operation);
		try {
			await this.wait(() => this.api.pa_operation_get_state(operation) !== 0, deadline);
			if (this.api.pa_operation_get_state(operation) !== 1 || !successful()) throw new Error('Pulse operation failed');
		} catch (error) {
			this.close();
			throw error;
		} finally {
			if (this.operations.delete(operation)) {
				if (this.api.pa_operation_get_state(operation) === 0) this.api.pa_operation_cancel(operation);
				this.api.pa_operation_unref(operation);
			}
		}
	}
	async sink(deadline: number): Promise<PulseSink> {
		let name = '';
		const server = this.callback(
			(_context, info) => {
				if (info) {
					const value = read.ptr(info as Pointer, 48);
					if (value) name = new CString(value as Pointer).toString();
				}
			},
			[FFIType.ptr, FFIType.ptr, FFIType.ptr]
		);
		try {
			await this.operation(this.api.pa_context_get_server_info(this.context, server.ptr, null), () => !!name, deadline);
		} finally {
			this.release(server);
		}
		let result: PulseSink | undefined;
		let ended = false;
		const sink = this.callback(
			(_context, info, end) => {
				if (end) {
					ended = end > 0;
					return;
				}
				if (!info) return;
				// Stable 64-bit libpulse ABI, shared by x86_64 and aarch64.
				const channels = read.u8(info as Pointer, 172);
				const value = read.u32(info as Pointer, 176);
				if (channels > 0 && channels <= 32 && value <= 0x7fffffff) result = { name, channels, volume: Math.min(100, Math.round((value * 100) / 65536)) };
			},
			[FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr]
		);
		const encoded = Buffer.from(name + '\0');
		try {
			await this.operation(this.api.pa_context_get_sink_info_by_name(this.context, ptr(encoded), sink.ptr, null), () => ended && !!result, deadline);
		} finally {
			this.release(sink);
		}
		return result!;
	}
	async write(percent: number, deadline: number): Promise<number> {
		const sink = await this.sink(deadline);
		if (performance.now() >= deadline) throw new PulseTimeout('Pulse deadline exhausted');
		const volume = new Uint8Array(132);
		this.api.pa_cvolume_set(ptr(volume), sink.channels, Math.round((percent * 65536) / 100));
		let success = false;
		const callback = this.callback(
			(_context, ok) => {
				success = ok !== 0;
			},
			[FFIType.ptr, FFIType.i32, FFIType.ptr]
		);
		const name = Buffer.from(sink.name + '\0');
		try {
			await this.operation(this.api.pa_context_set_sink_volume_by_name(this.context, ptr(name), ptr(volume), callback.ptr, null), () => success, deadline);
		} finally {
			this.release(callback);
		}
		return (await this.sink(deadline)).volume;
	}
	async subscribe(changed: () => void, deadline: number): Promise<void> {
		const events = this.callback(
			(_context, event) => {
				if ((event! & 15) === 0 || (event! & 15) === 7) changed();
			},
			[FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr]
		);
		this.api.pa_context_set_subscribe_callback(this.context, events.ptr, null);
		let success = false;
		const callback = this.callback(
			(_context, ok) => {
				success = ok !== 0;
			},
			[FFIType.ptr, FFIType.i32, FFIType.ptr]
		);
		try {
			await this.operation(this.api.pa_context_subscribe(this.context, 1 | 128, callback.ptr, null), () => success, deadline);
		} finally {
			this.release(callback);
		}
	}
	close(): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.context) {
			this.api.pa_context_set_state_callback(this.context, null, null);
			this.api.pa_context_set_subscribe_callback(this.context, null, null);
		}
		for (const operation of this.operations) {
			this.api.pa_operation_cancel(operation);
			this.api.pa_operation_unref(operation);
		}
		this.operations.clear();
		if (this.context) {
			this.api.pa_context_disconnect(this.context);
			this.api.pa_context_unref(this.context);
			this.context = null;
		}
		if (this.loop) {
			this.api.pa_mainloop_free(this.loop);
			this.loop = null;
		}
		for (const callback of this.callbacks) callback.close();
		this.callbacks.clear();
	}
}
