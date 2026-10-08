import { DBusTransportError, type DBusReply } from './linux/dbus.ts';

declare const LISH_NATIVE_WORKER_ENTRY: string | undefined;

export interface NativeWorkerRequest {
	readonly method: string;
	readonly args?: unknown;
}

export interface NativeWorkerErrorData {
	readonly name: string;
	readonly message: string;
	readonly stage?: DBusTransportError['stage'];
	readonly mayHaveBeenSent?: boolean;
	readonly errno?: number | null;
	readonly reply?: Omit<DBusReply, 'values'> | null;
}

export type NativeWorkerResponse = { readonly id: number; readonly ok: true; readonly value: unknown } | { readonly id: number; readonly ok: false; readonly error: NativeWorkerErrorData };

export interface NativeWorkerEvent {
	readonly event: string;
	readonly value?: unknown;
}

export interface NativeWorkerHooks {
	readonly onEvent?: (event: NativeWorkerEvent) => void;
	readonly onExit?: () => void;
}

export class NativeWorkerFailure extends Error {
	readonly mayHaveRun: boolean;
	constructor(message: string, mayHaveRun: boolean) {
		super(message);
		this.name = 'NativeWorkerFailure';
		this.mayHaveRun = mayHaveRun;
	}
}

interface Pending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout> | undefined;
}

function workerEntry(): string {
	return typeof LISH_NATIVE_WORKER_ENTRY === 'string' ? LISH_NATIVE_WORKER_ENTRY : new URL('./worker-runtime.ts', import.meta.url).href;
}

function remoteError(value: NativeWorkerErrorData): Error {
	if (value.name === 'DBusTransportError' && value.stage && typeof value.mayHaveBeenSent === 'boolean') return new DBusTransportError(value.message, value.stage, value.mayHaveBeenSent, value.errno ?? null, value.reply ?? null);
	const error = new Error(value.message);
	error.name = value.name;
	return error;
}

/** A mutation channel has no timeout and cannot be terminated while a call is outstanding. */
export class NativeWorkerChannel {
	private worker: Worker | null = null;
	private retiringRead: Worker | null = null;
	private readonly retiringReplies = new Set<number>();
	private readonly shuttingDown = new Set<Worker>();
	private readonly exits = new Map<Worker, Promise<void>>();
	private nextId = 0;
	private readonly pending = new Map<number, Pending>();
	private closed = false;
	private readonly kind: 'read' | 'mutation';
	private readonly entry: string;
	private readonly hooks: NativeWorkerHooks;

	constructor(kind: 'read' | 'mutation', entry: string = workerEntry(), hooks: NativeWorkerHooks = {}) {
		this.kind = kind;
		this.entry = entry;
		this.hooks = hooks;
	}

	call<T>(request: NativeWorkerRequest, timeoutMs?: number): Promise<T> {
		if (this.closed) return Promise.reject(new NativeWorkerFailure('Native worker is closed', false));
		if (this.kind === 'read' && (!Number.isFinite(timeoutMs) || timeoutMs! <= 0)) return Promise.reject(new NativeWorkerFailure('Native reads require a finite positive timeout', false));
		if (this.kind === 'mutation' && timeoutMs !== undefined) return Promise.reject(new NativeWorkerFailure('Native mutations cannot have a transport timeout', false));
		let worker: Worker;
		try {
			worker = this.getWorker();
		} catch (error) {
			return Promise.reject(new NativeWorkerFailure(String(error), false));
		}
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			const timer = timeoutMs === undefined ? undefined : setTimeout(() => this.fail(worker, new NativeWorkerFailure('Native read timed out', true), true), Math.min(timeoutMs, 0x7fffffff));
			this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
			worker.ref();
			try {
				worker.postMessage({ id, lane: this.kind, ...request });
			} catch (error) {
				this.remove(id);
				reject(new NativeWorkerFailure(String(error), false));
			}
		});
	}

	close(): boolean {
		if (this.kind === 'mutation' && this.pending.size) return false;
		this.closed = true;
		if (this.worker) this.fail(this.worker, new NativeWorkerFailure('Native worker closed', true), true);
		return true;
	}

	async waitUntilClosed(): Promise<void> {
		if (!this.closed) throw new Error('Close the native worker before waiting for its exit');
		await Promise.all(this.exits.values());
	}

	private getWorker(): Worker {
		if (this.worker) return this.worker;
		if (this.retiringRead) throw new NativeWorkerFailure('The previous native read has not stopped', false);
		const worker = new Worker(this.entry, { name: `native-${this.kind}` });
		let exited!: () => void;
		this.exits.set(
			worker,
			new Promise<void>(resolve => {
				exited = resolve;
			})
		);
		this.worker = worker;
		worker.unref();
		worker.onmessage = (event: MessageEvent<NativeWorkerResponse | NativeWorkerEvent>) => {
			if (this.shuttingDown.has(worker) && 'id' in event.data && event.data.id === 0) {
				worker.terminate();
				return;
			}
			if (this.retiringRead === worker && 'id' in event.data) {
				this.retiringReplies.delete(event.data.id);
				if (!this.retiringReplies.size) this.shutdown(worker);
				return;
			}
			if (this.worker !== worker) return;
			const reply = event.data;
			if ('event' in reply) {
				this.hooks.onEvent?.(reply);
				return;
			}
			const pending = this.remove(reply.id);
			if (!pending) return;
			if (reply.ok) pending.resolve(reply.value);
			else pending.reject(remoteError(reply.error));
		};
		worker.onerror = event => {
			event.preventDefault();
			this.fail(worker, new NativeWorkerFailure(event.message || 'Native worker failed', true), this.kind === 'read');
		};
		worker.addEventListener('close', () => {
			this.exits.delete(worker);
			exited();
			this.shuttingDown.delete(worker);
			if (this.retiringRead === worker) {
				this.retiringRead = null;
				this.retiringReplies.clear();
			}
			this.fail(worker, new NativeWorkerFailure('Native worker exited before replying', true), false);
		});
		return worker;
	}

	private shutdown(worker: Worker): void {
		if (this.shuttingDown.has(worker)) return;
		this.shuttingDown.add(worker);
		try {
			worker.postMessage({ id: 0, lane: this.kind, method: 'worker.close' });
		} catch {
			worker.terminate();
		}
	}

	private remove(id: number): Pending | undefined {
		const pending = this.pending.get(id);
		if (!pending) return undefined;
		clearTimeout(pending.timer);
		this.pending.delete(id);
		if (!this.pending.size) this.worker?.unref();
		return pending;
	}

	private fail(worker: Worker, error: Error, terminate: boolean): void {
		if (this.worker !== worker) return;
		this.worker = null;
		if (terminate && this.kind === 'read') {
			this.retiringRead = worker;
			for (const id of this.pending.keys()) this.retiringReplies.add(id);
		}
		for (const [id, pending] of this.pending) {
			this.remove(id);
			pending.reject(error);
		}
		worker.unref();
		if (terminate) {
			// Bun terminate() skips JS cleanup. Let native reads leave their finally first.
			if (!this.retiringReplies.size) this.shutdown(worker);
		}
		// An errored mutation worker may still be inside an FFI call.
		if (this.kind === 'mutation') this.closed = true;
		this.hooks.onExit?.();
	}
}

export interface NativeReadResult<T> {
	readonly value: T;
	readonly stale: boolean;
}

export class NativeSnapshotReader<T> {
	private snapshot: { value: T } | undefined;
	private readonly channel: NativeWorkerChannel;
	constructor(channel: NativeWorkerChannel) {
		this.channel = channel;
	}

	async read(request: NativeWorkerRequest, timeoutMs: number): Promise<NativeReadResult<T>> {
		try {
			const value = await this.channel.call<T>(request, timeoutMs);
			this.snapshot = { value };
			return { value, stale: false };
		} catch (error) {
			if (!this.snapshot) throw error;
			return { value: this.snapshot.value, stale: true };
		}
	}
}
