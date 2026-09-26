import { WsClient } from '@shared/client.ts';

interface EventHistoryEntry {
	event: string;
	data: any;
	time: number;
}

/** Default ceiling for one RPC; a call that never answers fails the test instead of hanging it. */
const CALL_TIMEOUT_MS = 30_000;

/**
 * WebSocket client for the e2e suite. Every wait is bounded, subscriptions are confirmed by the
 * server before a test acts, and closing stops the reconnect loop through the public API.
 */
export class TestClient {
	private client: WsClient;
	private eventHistory: EventHistoryEntry[] = [];
	private connected = false;
	private destroyed = false;
	/** Rejects every wait still open, so destroying the client ends them all. */
	private readonly waits = new Set<(error: Error) => void>();

	constructor(url: string) {
		this.client = new WsClient(url, (state: { connected: boolean }) => {
			this.connected = state.connected;
		});
		this.client.on('*', (msg: { event: string; data: any }) => {
			this.eventHistory.push({ event: msg.event, data: msg.data, time: Date.now() });
		});
	}

	async waitConnected(timeout: number = 10_000): Promise<void> {
		const start = Date.now();
		while (!this.connected && Date.now() - start < timeout) await Bun.sleep(100);
		if (!this.connected) {
			this.destroy();
			throw new Error('Connection timeout');
		}
	}

	/**
	 * One RPC, bounded by `timeout`. A call that times out ends the whole client: the request
	 * may still be queued behind a slow handshake, and it must not reach the server after the
	 * test has already moved on.
	 */
	async call<T = any>(method: string, params: Record<string, any> = {}, timeout: number = CALL_TIMEOUT_MS): Promise<T> {
		if (this.destroyed) throw new Error(`RPC ${method} on a destroyed client`);
		let cancel!: (error: Error) => void;
		const cancelled = new Promise<never>((_, reject) => (cancel = reject));
		this.waits.add(cancel);
		const timer = setTimeout(() => {
			cancel(new Error(`RPC ${method} timed out after ${timeout} ms`));
			this.destroy();
		}, timeout);
		try {
			return await Promise.race([this.client.call<T>(method, params, timeout), cancelled]);
		} finally {
			clearTimeout(timer);
			this.waits.delete(cancel);
		}
	}

	/** Subscribe and wait for the server to confirm, so no event after this call can be missed. */
	async subscribe(events: string[]): Promise<void> {
		await this.call('events.subscribe', { events });
	}

	async subscribeAll(): Promise<void> {
		await this.subscribe(['transfer.download:progress', 'transfer.download:disabled', 'transfer.download:enabled', 'transfer.download:complete', 'transfer.download:error', 'transfer.upload:progress', 'transfer.upload:disabled', 'transfer.upload:enabled', 'transfer.upload:stopped']);
	}

	/** Resolve with the first matching event, also one already received since the history was last cleared. */
	waitForEvent(eventName: string, predicate?: (data: any) => boolean, timeout: number = 30_000): Promise<any> {
		const seen = this.eventHistory.find(e => e.event === eventName && (!predicate || predicate(e.data)));
		if (seen) return Promise.resolve(seen.data);
		if (this.destroyed) return Promise.reject(new Error(`waiting for '${eventName}' on a destroyed client`));
		return new Promise((resolve, reject) => {
			const finish = (): void => {
				clearTimeout(timer);
				off();
				this.waits.delete(fail);
			};
			const fail = (error: Error): void => {
				finish();
				reject(error);
			};
			const timer = setTimeout(() => fail(new Error(`Timeout waiting for event '${eventName}'`)), timeout);
			const off = this.client.on(eventName, (data: any) => {
				if (!predicate || predicate(data)) {
					finish();
					resolve(data);
				}
			});
			this.waits.add(fail);
		});
	}

	async collectEvents(eventName: string, durationMs: number): Promise<any[]> {
		const collected: any[] = [];
		const off = this.client.on(eventName, (data: any) => collected.push(data));
		await Bun.sleep(durationMs);
		off();
		return collected;
	}

	getEventHistory(eventName?: string): EventHistoryEntry[] {
		if (!eventName) return [...this.eventHistory];
		return this.eventHistory.filter(e => e.event === eventName);
	}

	clearHistory(): void {
		this.eventHistory = [];
	}

	/** Close the socket for good and reject every call and wait still open. */
	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.client.stopReconnect();
		for (const fail of [...this.waits]) fail(new Error('client destroyed'));
		this.waits.clear();
	}
}
