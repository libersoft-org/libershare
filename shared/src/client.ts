import { CodedError, ErrorCodes } from './errors.ts';
import { MAX_API_MESSAGE_SIZE, MAX_UPLOAD_CHUNK_SIZE } from './product.ts';
import { formatBytes } from './utils.ts';

type EventCallback = (data: any) => void;

interface PendingRequest {
	resolve: (result: any) => void;
	reject: (error: Error) => void;
}

interface State {
	connected: boolean;
}

export class WsClient {
	private ws: WebSocket | null = null;
	private pendingRequests = new Map<string, PendingRequest>();
	private eventListeners = new Map<string, Set<EventCallback>>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private connected = false;
	private connectPromise: Promise<void> | null = null;
	private autoReconnect = true;
	private apiURL: string;
	private onStateChange: (state: State) => void;
	onError?: (error: any) => void;

	constructor(apiURL: string, onStateChange: (state: State) => void) {
		this.apiURL = apiURL;
		this.onStateChange = onStateChange;
		this.connect().catch(() => {});
	}

	private connect(): Promise<void> {
		if (this.connected && this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
		if (this.connectPromise) return this.connectPromise;
		this.connectPromise = new Promise((resolve, reject) => {
			this.ws = new WebSocket(this.apiURL);
			this.ws.onopen = () => {
				this.connected = true;
				this.onStateChange({ connected: true });
				this.connectPromise = null;
				resolve();
			};
			this.ws.onclose = () => {
				this.connected = false;
				this.onStateChange({ connected: false });
				this.connectPromise = null;
				this.ws = null;
				for (const [, pending] of this.pendingRequests) pending.reject(new Error('WebSocket disconnected'));
				this.pendingRequests.clear();
				this.scheduleReconnect();
			};
			this.ws.onerror = err => {
				this.onError?.(err);
				if (!this.connected) {
					this.connectPromise = null;
					reject(new Error('WebSocket connection failed'));
				}
			};
			this.ws.onmessage = event => this.handleMessage(event.data);
		});
		return this.connectPromise;
	}

	private scheduleReconnect(): void {
		if (!this.autoReconnect) return;
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect().catch(() => {});
		}, 2000);
	}

	setAPIURL(apiURL: string): void {
		if (this.apiURL === apiURL) return;
		this.apiURL = apiURL;
		this.reconnect();
	}

	setAutoReconnect(enabled: boolean): void {
		this.autoReconnect = enabled;
		if (!enabled && this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (enabled && !this.connected && !this.connectPromise) this.scheduleReconnect();
	}

	reconnect(): void {
		this.setAutoReconnect(true);
		if (this.ws) {
			this.ws.close();
			return;
		}
		this.connect().catch(() => {});
	}

	stopReconnect(): void {
		this.setAutoReconnect(false);
		if (this.ws) this.ws.close();
	}

	private handleMessage(data: string): void {
		let msg: any;
		try {
			msg = JSON.parse(data);
		} catch {
			console.error('[API] Invalid JSON:', data);
			return;
		}

		// Event message
		if (msg.event) {
			const listeners = this.eventListeners.get(msg.event);
			if (listeners) listeners.forEach(cb => cb(msg.data));
			// Also notify wildcard listeners
			const wildcardListeners = this.eventListeners.get('*');
			if (wildcardListeners) wildcardListeners.forEach(cb => cb({ event: msg.event, data: msg.data }));
			return;
		}

		// Response message
		if (msg.id !== undefined) {
			const pending = this.pendingRequests.get(msg.id);
			if (pending) {
				this.pendingRequests.delete(msg.id);
				if (msg.error) {
					const err = new Error(msg.error);
					(err as any).code = msg.error;
					(err as any).detail = msg.errorDetail;
					pending.reject(err);
				} else pending.resolve(msg.result);
			}
		}
	}

	private async ensureConnected(): Promise<void> {
		if (this.connected && this.ws?.readyState === WebSocket.OPEN) return;
		await this.connect();
	}

	/**
	 * Call a method with a raw binary payload attached, framed as
	 * `[uint32 BE header length][header JSON][payload]`. The header is the same
	 * `{ id, method, params }` a text request carries, so the reply comes back as
	 * an ordinary JSON response and every existing mechanism — id correlation,
	 * error codes, rejection on disconnect — applies unchanged. The payload
	 * reaches the handler as `params.data` without being base64'd, which would
	 * otherwise cost a third more bytes and two full passes over the file.
	 */
	async callBinary<T = any>(method: string, params: Record<string, any>, payload: Uint8Array): Promise<T> {
		await this.ensureConnected();
		const id = crypto.randomUUID();
		const header = new TextEncoder().encode(JSON.stringify({ id, method, params }));
		// Both limits are checked before the frame is allocated: building a copy of
		// an oversized payload only to reject it doubles the peak memory of the very
		// case the limit exists to prevent.
		if (payload.byteLength > MAX_UPLOAD_CHUNK_SIZE) throw new CodedError(ErrorCodes.UPLOAD_CHUNK_TOO_LARGE, formatBytes(MAX_UPLOAD_CHUNK_SIZE));
		if (4 + header.byteLength + payload.byteLength > MAX_API_MESSAGE_SIZE) throw new CodedError(ErrorCodes.MESSAGE_TOO_LARGE, formatBytes(MAX_API_MESSAGE_SIZE));
		const frame = new Uint8Array(4 + header.byteLength + payload.byteLength);
		new DataView(frame.buffer).setUint32(0, header.byteLength);
		frame.set(header, 4);
		frame.set(payload, 4 + header.byteLength);
		return new Promise<T>((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });
			this.ws!.send(frame);
		});
	}

	async call<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
		await this.ensureConnected();
		const id = crypto.randomUUID();
		const request = JSON.stringify({ id, method, params });
		// The server closes the socket outright on an oversized frame, and the
		// caller only ever sees "disconnected" — so refuse here and hand back a
		// real error code. The server counts UTF-8 bytes, so the string length is
		// only a cheap pre-filter: one UTF-16 unit is at most three UTF-8 bytes,
		// so anything under a third of the limit provably fits and skips the copy
		// that measuring the real byte length costs.
		if (request.length * 3 > MAX_API_MESSAGE_SIZE && new Blob([request]).size > MAX_API_MESSAGE_SIZE) throw new CodedError(ErrorCodes.MESSAGE_TOO_LARGE, formatBytes(MAX_API_MESSAGE_SIZE));
		return new Promise<T>((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });
			this.ws!.send(request);
		});
	}

	on(event: string, callback: EventCallback): () => void {
		let listeners = this.eventListeners.get(event);
		if (!listeners) {
			listeners = new Set();
			this.eventListeners.set(event, listeners);
		}
		listeners.add(callback);

		return () => {
			listeners!.delete(callback);
			if (listeners!.size === 0) this.eventListeners.delete(event);
		};
	}

	off(event: string, callback: EventCallback): void {
		const listeners = this.eventListeners.get(event);
		if (listeners) {
			listeners.delete(callback);
			if (listeners.size === 0) this.eventListeners.delete(event);
		}
	}
}
