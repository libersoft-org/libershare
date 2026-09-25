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

	async call<T = any>(method: string, params: Record<string, any> = {}, timeout: number = CALL_TIMEOUT_MS): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				this.client.call<T>(method, params),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`RPC ${method} timed out after ${timeout} ms`)), timeout);
				}),
			]);
		} finally {
			clearTimeout(timer);
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
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				off();
				reject(new Error(`Timeout waiting for event '${eventName}'`));
			}, timeout);
			const off = this.client.on(eventName, (data: any) => {
				if (!predicate || predicate(data)) {
					clearTimeout(timer);
					off();
					resolve(data);
				}
			});
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

	destroy(): void {
		this.client.stopReconnect();
	}
}
