import { CodedError, ErrorCodes } from './errors.ts';
import { MAX_API_MESSAGE_SIZE, MAX_UPLOAD_CHUNK_SIZE } from './product.ts';
import { formatBytes } from './utils.ts';

export interface RpcSession {
	send(frame: string | Uint8Array): void | Promise<void>;
	close(): void | Promise<void>;
}

export interface RpcTransport {
	connect(handlers: { message: (frame: string) => void; closed: (error?: Error) => void }, signal: AbortSignal): Promise<RpcSession>;
}

export interface RpcState {
	connected: boolean;
}
type EventCallback = (data: any) => void;
interface PendingRequest {
	resolve: (result: any) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout> | undefined;
}
const MAX_PENDING_REQUESTS: number = 1024;

export class RpcClient {
	private readonly transport: RpcTransport;
	private readonly onStateChange: (state: RpcState) => void;
	private session: RpcSession | null = null;
	private connecting: Promise<void> | null = null;
	private connectController: AbortController | null = null;
	private generation = 0;
	private autoReconnect = true;
	private destroyed = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly listeners = new Map<string, Set<EventCallback>>();
	private queuedBytes = 0;
	onError?: (error: unknown) => void;

	constructor(transport: RpcTransport, onStateChange: (state: RpcState) => void) {
		this.transport = transport;
		this.onStateChange = onStateChange;
		void this.connect().catch(() => {});
	}

	private connect(): Promise<void> {
		if (this.destroyed) return Promise.reject(new Error('RPC client destroyed'));
		if (this.session) return Promise.resolve();
		if (this.connecting) return this.connecting;
		const generation = ++this.generation;
		const controller = new AbortController();
		this.connectController = controller;
		const current = (): boolean => generation === this.generation && !this.destroyed;
		const operation = Promise.resolve()
			.then(() =>
				this.transport.connect(
					{
						message: frame => {
							if (!current()) return;
							try {
								this.receive(frame);
							} catch {
								this.onError?.(new Error('Invalid RPC response'));
							}
						},
						closed: error => {
							if (current()) this.disconnected(error ?? new Error('Backend disconnected'));
						},
					},
					controller.signal
				)
			)
			.then(
				session => {
					if (!current()) {
						void Promise.resolve()
							.then(() => session.close())
							.catch(() => {});
						throw new Error('Connection replaced');
					}
					this.session = session;
					this.connecting = null;
					this.onStateChange({ connected: true });
				},
				error => {
					if (current()) {
						this.disconnected(new Error('Backend connection failed'));
						this.onError?.(new Error('Backend connection failed'));
					}
					throw error;
				}
			);
		this.connecting = operation;
		return operation;
	}

	private disconnected(error: Error): void {
		this.generation++;
		this.connectController?.abort();
		this.connectController = null;
		this.connecting = null;
		const session = this.session;
		this.session = null;
		if (session)
			void Promise.resolve()
				.then(() => session.close())
				.catch(() => {});
		for (const request of this.pending.values()) {
			if (request.timer) clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
		this.onStateChange({ connected: false });
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (!this.autoReconnect || this.destroyed || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.connect().catch(() => {});
		}, 2000);
	}

	setAutoReconnect(enabled: boolean): void {
		this.autoReconnect = enabled;
		if (!enabled && this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (enabled && !this.session && !this.connecting) this.scheduleReconnect();
	}

	reconnect(): void {
		this.setAutoReconnect(true);
		this.disconnected(new Error('Backend connection replaced'));
	}

	stopReconnect(): void {
		this.setAutoReconnect(false);
		if (this.session || this.connecting) this.disconnected(new Error('Backend disconnected'));
	}

	destroy(): void {
		this.destroyed = true;
		this.stopReconnect();
		this.listeners.clear();
	}

	private receive(frame: string): void {
		const message = JSON.parse(frame);
		if (message.event) {
			for (const callback of this.listeners.get(message.event) ?? []) callback(message.data);
			for (const callback of this.listeners.get('*') ?? []) callback({ event: message.event, data: message.data });
			return;
		}
		const request = this.pending.get(message.id);
		if (!request) return;
		this.pending.delete(message.id);
		if (request.timer) clearTimeout(request.timer);
		if (message.error) request.reject(Object.assign(new Error(message.error), { code: message.error, detail: message.errorDetail }));
		else request.resolve(message.result);
	}

	async call<T = any>(method: string, params: Record<string, any> = {}, timeoutMs?: number): Promise<T> {
		const id = crypto.randomUUID();
		const frame = JSON.stringify({ id, method, params });
		return this.send<T>(id, frame, new Blob([frame]).size, timeoutMs);
	}

	async callBinary<T = any>(method: string, params: Record<string, any>, payload: Uint8Array, timeoutMs?: number): Promise<T> {
		if (payload.byteLength > MAX_UPLOAD_CHUNK_SIZE) return Promise.reject(new CodedError(ErrorCodes.UPLOAD_CHUNK_TOO_LARGE, formatBytes(MAX_UPLOAD_CHUNK_SIZE)));
		const id = crypto.randomUUID();
		const header = new TextEncoder().encode(JSON.stringify({ id, method, params }));
		const size = 4 + header.byteLength + payload.byteLength;
		if (size > MAX_API_MESSAGE_SIZE) return Promise.reject(new CodedError(ErrorCodes.MESSAGE_TOO_LARGE, formatBytes(MAX_API_MESSAGE_SIZE)));
		const frame = new Uint8Array(size);
		new DataView(frame.buffer).setUint32(0, header.byteLength);
		frame.set(header, 4);
		frame.set(payload, 4 + header.byteLength);
		return this.send<T>(id, frame, size, timeoutMs);
	}

	private send<T>(id: string, frame: string | Uint8Array, bytes: number, timeoutMs?: number): Promise<T> {
		if (bytes > MAX_API_MESSAGE_SIZE) return Promise.reject(new CodedError(ErrorCodes.MESSAGE_TOO_LARGE, formatBytes(MAX_API_MESSAGE_SIZE)));
		if (this.pending.size >= MAX_PENDING_REQUESTS || this.queuedBytes + bytes > MAX_API_MESSAGE_SIZE) return Promise.reject(new Error('RPC queue is full'));
		this.queuedBytes += bytes;
		let released = false;
		let sending = false;
		const release = (): void => {
			if (!released) {
				released = true;
				this.queuedBytes -= bytes;
			}
		};
		return new Promise<T>((resolve, reject) => {
			const fail = (error: Error): void => {
				const request = this.pending.get(id);
				if (request?.timer) clearTimeout(request.timer);
				this.pending.delete(id);
				if (!sending) release();
				reject(error);
			};
			const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => fail(new CodedError(ErrorCodes.REQUEST_TIMEOUT, String(timeoutMs))), timeoutMs) : undefined;
			this.pending.set(id, { resolve, reject: fail, timer });
			void this.connect()
				.then(async () => {
					if (!this.pending.has(id)) {
						release();
						return;
					}
					if (!this.session) throw new Error('Backend disconnected');
					sending = true;
					try {
						await this.session.send(frame);
					} finally {
						release();
					}
				})
				.catch(error => fail(error instanceof Error ? error : new Error('RPC send failed')));
		});
	}

	on(event: string, callback: EventCallback): () => void {
		let callbacks = this.listeners.get(event);
		if (!callbacks) {
			callbacks = new Set();
			this.listeners.set(event, callbacks);
		}
		callbacks.add(callback);
		return () => this.off(event, callback);
	}

	off(event: string, callback: EventCallback): void {
		const callbacks = this.listeners.get(event);
		callbacks?.delete(callback);
		if (callbacks?.size === 0) this.listeners.delete(event);
	}
}
