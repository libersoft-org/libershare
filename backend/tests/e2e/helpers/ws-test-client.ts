import { WsClient } from '../../../shared/src/client.ts';

export class TestClient {
	private client: WsClient;
	private eventHistory: { event: string; data: any; time: number }[] = [];
	private connected = false;

	constructor(url: string) {
		this.client = new WsClient(url, state => {
			this.connected = state.connected;
		});
		this.client.on('*', (msg: { event: string; data: any }) => {
			this.eventHistory.push({ event: msg.event, data: msg.data, time: Date.now() });
		});
	}

	async waitConnected(timeout = 5000): Promise<void> {
		const start = Date.now();
		while (!this.connected && Date.now() - start < timeout) await new Promise(r => setTimeout(r, 100));
		if (!this.connected) throw new Error('Connection timeout');
	}

	async call<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
		return this.client.call<T>(method, params);
	}

	subscribe(event: string): void {
		this.call('events.subscribe', { events: [event] }).catch(() => {});
	}

	subscribeAll(): void {
		const events = ['transfer.download:progress', 'transfer.download:disabled', 'transfer.download:enabled', 'transfer.download:complete', 'transfer.download:error', 'transfer.upload:progress', 'transfer.upload:disabled', 'transfer.upload:enabled', 'transfer.upload:stopped'];
		for (const e of events) this.subscribe(e);
	}

	waitForEvent(eventName: string, predicate?: (data: any) => boolean, timeout = 30000): Promise<any> {
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
		await new Promise(r => setTimeout(r, durationMs));
		off();
		return collected;
	}

	getEventHistory(eventName?: string): { event: string; data: any; time: number }[] {
		if (!eventName) return [...this.eventHistory];
		return this.eventHistory.filter(e => e.event === eventName);
	}

	clearHistory(): void {
		this.eventHistory = [];
	}

	destroy(): void {
		(this.client as any).ws?.close();
		if ((this.client as any).reconnectTimer) clearTimeout((this.client as any).reconnectTimer);
		(this.client as any).reconnectTimer = 'killed'; // prevent reconnect
	}
}
