
/*
 * A simple API client that communicates with a server over WebSocket.
 * we should partly unify this with the
 */

interface Request {
	id: number;
	method: string;
	params?: Record<string, any>;
}

interface Response {
	id: number;
	result?: any;
	error?: string;
}

export class ApiClient {
	private ws: WebSocket | null = null;
	private requestId = 0;
	private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	private eventHandlers = new Map<string, ((data: any) => void)[]>();

	constructor(private readonly url: string) {}

	async connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(this.url);

			this.ws.onopen = () => resolve();
			this.ws.onerror = (err) => reject(new Error(`WebSocket error: ${err}`));

			this.ws.onmessage = (event) => {
				const msg = JSON.parse(event.data as string);

				if (msg.id !== undefined) {
					// Response to a request
					const pending = this.pending.get(msg.id);
					if (pending) {
						this.pending.delete(msg.id);
						if (msg.error) {
							pending.reject(new Error(msg.error));
						} else {
							pending.resolve(msg.result);
						}
					}
				} else if (msg.event) {
					// Event notification
					const handlers = this.eventHandlers.get(msg.event) || [];
					handlers.forEach(h => h(msg.data));
				}
			};

			this.ws.onclose = () => {
				// Reject all pending requests
				for (const [id, pending] of this.pending) {
					pending.reject(new Error('Connection closed'));
				}
				this.pending.clear();
			};
		});
	}

	async call<T = any>(method: string, params?: Record<string, any>): Promise<T> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error('Not connected');
		}

		const id = ++this.requestId;
		const request: Request = { id, method, params };

		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws!.send(JSON.stringify(request));
		});
	}

	on(event: string, handler: (data: any) => void): void {
		const handlers = this.eventHandlers.get(event) || [];
		handlers.push(handler);
		this.eventHandlers.set(event, handlers);
	}

	off(event: string, handler: (data: any) => void): void {
		const handlers = this.eventHandlers.get(event) || [];
		const index = handlers.indexOf(handler);
		if (index !== -1) {
			handlers.splice(index, 1);
		}
	}

	close(): void {
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}
}
