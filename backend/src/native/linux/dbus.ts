import { ptr, read, type Pointer } from 'bun:ffi';
import { retainDBusCallback, type DBusCallback } from './dbus-callbacks.ts';
import { copyDBusString, dbusCString, decodeDBus, encodeDBus, type DBusValue, type DBusVariant } from './dbus-codec.ts';
import { checkSdBus, loadSdBus, nativePointer, type SdBusSymbols } from './dbus-native.ts';

export { variant, type DBusValue, type DBusVariant } from './dbus-codec.ts';

export function isUniqueDBusName(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 255 && /^:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(value);
}

interface MethodCall {
	readonly destination: string;
	readonly path: string;
	readonly interface: string;
	readonly member: string;
	readonly signature?: string;
	readonly args?: readonly DBusValue[];
}
export type DBusRequest = MethodCall & ({ readonly kind: 'read'; readonly timeoutUsec?: bigint; readonly signal?: AbortSignal } | { readonly kind: 'mutation' });
export interface DBusReply {
	readonly type: 'method_return' | 'error';
	readonly sender: string | null;
	readonly signature: string;
	readonly values: DBusValue[];
	readonly errorName: string | null;
	readonly errorMessage: string | null;
}
export interface DBusOptions {
	readonly bus?: 'system' | 'user';
	readonly interactive?: boolean;
}

export interface DBusSignalMatch {
	readonly sender: string;
	readonly path: string;
	readonly interface: string;
	readonly member: string;
}
export interface DBusSignal extends DBusSignalMatch {
	readonly type: 'signal';
	readonly signature: string;
	readonly values: DBusValue[];
}
export interface DBusSubscription {
	close(): void;
}

interface SignalSubscription {
	readonly slotOut: BigUint64Array;
	readonly callback: DBusCallback;
	readonly listener: (signal: DBusSignal) => void;
	readonly onError: (error: Error) => void;
}

export class DBusError extends Error {
	readonly reply: DBusReply;
	readonly errorName: string;
	constructor(reply: DBusReply) {
		super(`${reply.errorName ?? 'D-Bus error'}: ${reply.errorMessage ?? ''}`);
		this.name = 'DBusError';
		this.reply = reply;
		this.errorName = reply.errorName ?? 'org.freedesktop.DBus.Error.Failed';
	}
}

export class DBusTransportError extends Error {
	readonly stage: 'before-send' | 'send' | 'process' | 'decode' | 'cancelled' | 'closed';
	readonly mayHaveBeenSent: boolean;
	readonly errno: number | null;
	readonly reply: Omit<DBusReply, 'values'> | null;
	constructor(message: string, stage: DBusTransportError['stage'], mayHaveBeenSent: boolean, errno: number | null = null, reply: Omit<DBusReply, 'values'> | null = null) {
		super(message);
		this.name = 'DBusTransportError';
		this.stage = stage;
		this.mayHaveBeenSent = mayHaveBeenSent;
		this.errno = errno;
		this.reply = reply;
	}
}

interface PendingCall {
	readonly callback: DBusCallback;
	readonly slotOut: BigUint64Array;
	readonly resolve: (reply: DBusReply) => void;
	readonly reject: (error: Error) => void;
	readonly signal: AbortSignal | undefined;
	readonly abort: () => void;
	result: DBusReply | Error | undefined;
}

/** Owns one sd-bus connection. Instantiate only inside the native worker. */
export class SystemBus {
	private readonly sd: SdBusSymbols;
	private bus: Pointer | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly pending = new Set<PendingCall>();
	private readonly subscriptions = new Set<SignalSubscription>();
	private signalQueue: { subscription: SignalSubscription; value: DBusSignal | Error }[] = [];
	private processing = false;
	private closeRequested = false;

	constructor(options: DBusOptions = {}, sd: SdBusSymbols = loadSdBus()) {
		this.sd = sd;
		const out = new BigUint64Array(1);
		const result = options.bus === 'user' ? sd.sd_bus_open_user(ptr(out)) : sd.sd_bus_open_system(ptr(out));
		if (result < 0) {
			if (out[0]) sd.sd_bus_close_unref(nativePointer(out[0]));
			throw new DBusTransportError(`Cannot open D-Bus: errno ${-result}`, 'before-send', false, -result);
		}
		this.bus = nativePointer(out[0]!);
		try {
			checkSdBus(sd.sd_bus_set_allow_interactive_authorization(this.bus, options.interactive ? 1 : 0), 'interactive authorization');
		} catch (error) {
			this.close();
			throw error;
		}
	}

	get uniqueName(): string {
		if (!this.bus || this.closeRequested) throw new DBusTransportError('D-Bus connection is closed', 'before-send', false);
		const out = new BigUint64Array(1);
		checkSdBus(this.sd.sd_bus_get_unique_name(this.bus, ptr(out)), 'get unique name');
		const name = copyDBusString(out[0]!, 255);
		if (!name) throw new Error('D-Bus returned an empty unique name');
		return name;
	}

	/** Error replies retain their sender; they are not transport failures or proof of no change. */
	call(request: DBusRequest): Promise<DBusReply> {
		return new Promise((resolve, reject) => {
			let message: Pointer | null = null;
			let pending: PendingCall | undefined;
			let enteredSend = false;
			try {
				if (!this.bus || this.closeRequested) throw new DBusTransportError('D-Bus connection is closed', 'before-send', false);
				if (request.kind === 'mutation' && !isUniqueDBusName(request.destination)) throw new DBusTransportError('A mutation requires the recorded unique destination', 'before-send', false);
				const signal = request.kind === 'read' ? request.signal : undefined;
				if (signal?.aborted) throw new DBusTransportError('D-Bus read cancelled before send', 'before-send', false);
				const timeout = request.kind === 'mutation' ? 0xffffffffffffffffn : (request.timeoutUsec ?? 25_000_000n);
				if (timeout <= 0n || (request.kind === 'read' && timeout >= 0xffffffffffffffffn)) throw new DBusTransportError('D-Bus reads require a finite positive timeout', 'before-send', false);
				const strings = [request.destination, request.path, request.interface, request.member].map(dbusCString);
				const out = new BigUint64Array(1);
				const created = this.sd.sd_bus_message_new_method_call(this.bus, ptr(out), ptr(strings[0]!), ptr(strings[1]!), ptr(strings[2]!), ptr(strings[3]!));
				if (out[0]) message = nativePointer(out[0]);
				checkSdBus(created, 'new method call');
				if (!message) throw new Error('D-Bus did not create a message');
				encodeDBus(this.sd, message, request.signature ?? '', request.args ?? []);
				const callback = retainDBusCallback((replyAddress: Pointer) => {
					// sd_bus_process owns the borrowed reply. Never release the callback on this stack.
					if (pending && !pending.result) pending.result = this.copyReply(replyAddress);
				});
				pending = {
					callback,
					slotOut: new BigUint64Array(1),
					resolve,
					reject,
					signal,
					result: undefined,
					abort: () => {
						if (!pending || pending.result) return;
						pending.result = new DBusTransportError('D-Bus read cancelled; the remote call may still run', 'cancelled', true);
						if (!this.processing) this.finish(pending);
					},
				};
				this.pending.add(pending);
				enteredSend = true;
				const sent = this.sd.sd_bus_call_async(this.bus, ptr(pending.slotOut), message, callback.ptr, callback.userdata, timeout);
				// sd_bus_send queues partial writes and returns success; a negative call_async return queued no message.
				if (sent < 0) throw new DBusTransportError(`D-Bus send failed: errno ${-sent}`, 'before-send', false, -sent);
				signal?.addEventListener('abort', pending.abort, { once: true });
				this.schedule();
			} catch (error) {
				const failure = error instanceof DBusTransportError ? error : new DBusTransportError(String(error), enteredSend ? 'send' : 'before-send', enteredSend);
				if (pending) {
					pending.result = failure;
					this.finish(pending);
				} else reject(failure);
			} finally {
				if (message) this.sd.sd_bus_message_unref(message);
			}
		});
	}

	async getProperty(destination: string, path: string, iface: string, name: string, signal?: AbortSignal): Promise<DBusVariant> {
		const reply = await this.call({ kind: 'read', destination, path, interface: 'org.freedesktop.DBus.Properties', member: 'Get', signature: 'ss', args: [iface, name], ...(signal ? { signal } : {}) });
		if (reply.type === 'error') throw new DBusError(reply);
		const value = reply.values[0];
		if (reply.signature !== 'v' || !value || typeof value !== 'object' || !('sig' in value) || !('value' in value)) throw new DBusTransportError('Invalid Get reply', 'decode', true, null, reply);
		return value as DBusVariant;
	}

	/** Registration is acknowledged before returning; install before a method whose signals may arrive first. */
	subscribe(match: DBusSignalMatch, listener: (signal: DBusSignal) => void, onError: (error: Error) => void): DBusSubscription {
		if (!this.bus || this.closeRequested) throw new DBusTransportError('D-Bus connection is closed', 'before-send', false);
		const fields = Object.entries(match);
		if (fields.length !== 4 || fields.some(([key, value]) => !['sender', 'path', 'interface', 'member'].includes(key) || !value || !/^[A-Za-z0-9_.:/-]+$/.test(value))) throw new Error('Invalid D-Bus signal match');
		const rule = dbusCString(`type='signal',${fields.map(([key, value]) => `${key}='${value}'`).join(',')}`);
		let subscription: SignalSubscription;
		const callback = retainDBusCallback((message: Pointer) => {
			let value: DBusSignal | Error;
			try {
				value = {
					type: 'signal',
					sender: copyDBusString(this.sd.sd_bus_message_get_sender(message), 255) ?? '',
					path: copyDBusString(this.sd.sd_bus_message_get_path(message)) ?? '',
					interface: copyDBusString(this.sd.sd_bus_message_get_interface(message), 255) ?? '',
					member: copyDBusString(this.sd.sd_bus_message_get_member(message), 255) ?? '',
					signature: copyDBusString(this.sd.sd_bus_message_get_signature(message, 1), 255) ?? '',
					values: decodeDBus(this.sd, message),
				};
			} catch (error) {
				value = new DBusTransportError(`Cannot decode D-Bus signal: ${String(error)}`, 'decode', true);
			}
			this.signalQueue.push({ subscription, value });
		});
		subscription = { callback, slotOut: new BigUint64Array(1), listener, onError };
		this.subscriptions.add(subscription);
		try {
			checkSdBus(this.sd.sd_bus_add_match(this.bus, ptr(subscription.slotOut), ptr(rule), callback.ptr, callback.userdata), 'add match');
		} catch (error) {
			this.releaseSubscription(subscription);
			throw error;
		}
		this.schedule();
		return { close: () => this.releaseSubscription(subscription) };
	}

	async getAll(destination: string, path: string, iface: string, signal?: AbortSignal): Promise<Record<string, DBusVariant>> {
		const reply = await this.call({ kind: 'read', destination, path, interface: 'org.freedesktop.DBus.Properties', member: 'GetAll', signature: 's', args: [iface], ...(signal ? { signal } : {}) });
		if (reply.type === 'error') throw new DBusError(reply);
		if (reply.signature !== 'a{sv}' || reply.values.length !== 1) throw new DBusTransportError('Invalid GetAll reply', 'decode', true, null, reply);
		return reply.values[0] as Record<string, DBusVariant>;
	}

	roundTrip(signature: string, args: readonly DBusValue[]): DBusValue[] {
		if (!this.bus || this.closeRequested) throw new DBusTransportError('D-Bus connection is closed', 'before-send', false);
		const strings = ['/org/libershare/Codec', 'org.libershare.Codec', 'RoundTrip'].map(dbusCString);
		const out = new BigUint64Array(1);
		checkSdBus(this.sd.sd_bus_message_new_signal(this.bus, ptr(out), ptr(strings[0]!), ptr(strings[1]!), ptr(strings[2]!)), 'new signal');
		const message = nativePointer(out[0]!);
		try {
			encodeDBus(this.sd, message, signature, args);
			checkSdBus(this.sd.sd_bus_message_seal(message, 1n, 0n), 'seal');
			checkSdBus(this.sd.sd_bus_message_rewind(message, 1), 'rewind');
			return decodeDBus(this.sd, message);
		} finally {
			this.sd.sd_bus_message_unref(message);
		}
	}

	/** Closing abandons local observation, never proves that a remote mutation stopped. */
	close(): void {
		this.closeRequested = true;
		if (this.processing) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		for (const pending of this.pending) {
			pending.result ??= new DBusTransportError('D-Bus connection closed before reply', 'closed', true);
			this.finish(pending);
		}
		for (const subscription of this.subscriptions) this.releaseSubscription(subscription);
		this.signalQueue = [];
		if (this.bus) this.sd.sd_bus_close_unref(this.bus);
		this.bus = null;
	}

	private copyReply(message: Pointer): DBusReply | DBusTransportError {
		let metadata: Omit<DBusReply, 'values'> | null = null;
		try {
			const typeOut = new Uint8Array(1);
			checkSdBus(this.sd.sd_bus_message_get_type(message, ptr(typeOut)), 'reply type');
			if (typeOut[0] !== 2 && typeOut[0] !== 3) throw new Error('Unexpected D-Bus reply type');
			const error = this.sd.sd_bus_message_get_error(message);
			metadata = {
				type: typeOut[0] === 2 ? 'method_return' : 'error',
				sender: copyDBusString(this.sd.sd_bus_message_get_sender(message), 255),
				signature: copyDBusString(this.sd.sd_bus_message_get_signature(message, 1), 255) ?? '',
				errorName: error ? copyDBusString(read.ptr(error, 0), 255) : null,
				errorMessage: error ? copyDBusString(read.ptr(error, 8)) : null,
			};
			return { ...metadata, values: decodeDBus(this.sd, message) };
		} catch (error) {
			return new DBusTransportError(`Cannot decode D-Bus reply: ${String(error)}`, 'decode', true, null, metadata);
		}
	}

	private schedule(): void {
		if (!this.timer && !this.closeRequested && (this.pending.size || this.subscriptions.size)) this.timer = setTimeout(() => this.pump(), 5);
	}

	private pump(): void {
		this.timer = undefined;
		if (!this.bus || this.closeRequested) return;
		this.processing = true;
		try {
			for (let i = 0; i < 64; i++) {
				const result = this.sd.sd_bus_process(this.bus, null);
				if (result < 0) throw new DBusTransportError(`D-Bus processing failed: errno ${-result}`, 'process', true, -result);
				if (result === 0) break;
			}
		} catch (error) {
			const failure = error instanceof DBusTransportError ? error : new DBusTransportError(String(error), 'process', true);
			for (const pending of this.pending) pending.result ??= failure;
			for (const subscription of this.subscriptions) this.signalQueue.push({ subscription, value: failure });
			this.closeRequested = true;
		} finally {
			this.processing = false;
		}
		const signals = this.signalQueue;
		this.signalQueue = [];
		for (const { subscription, value } of signals) {
			if (!this.subscriptions.has(subscription)) continue;
			try {
				if (value instanceof Error) throw value;
				subscription.listener(value);
			} catch (error) {
				this.releaseSubscription(subscription);
				try {
					subscription.onError(error instanceof Error ? error : new Error(String(error)));
				} catch (listenerError) {
					queueMicrotask(() => {
						throw listenerError;
					});
				}
			}
		}
		for (const pending of this.pending) if (pending.result) this.finish(pending);
		if (this.closeRequested) this.close();
		else this.schedule();
	}

	private finish(pending: PendingCall): void {
		if (!pending.result || !this.pending.delete(pending)) return;
		pending.signal?.removeEventListener('abort', pending.abort);
		// sd-bus must lose the slot before its userdata token leaves the registry.
		if (pending.slotOut[0]) this.sd.sd_bus_slot_unref(nativePointer(pending.slotOut[0]));
		pending.callback.close();
		if (pending.result instanceof Error) pending.reject(pending.result);
		else pending.resolve(pending.result);
	}

	private releaseSubscription(subscription: SignalSubscription): void {
		if (!this.subscriptions.delete(subscription)) return;
		if (subscription.slotOut[0]) this.sd.sd_bus_slot_unref(nativePointer(subscription.slotOut[0]));
		subscription.callback.close();
	}
}
