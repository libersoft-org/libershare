import { RpcClient, type RpcSession, type RpcState, type RpcTransport } from './rpc-client.ts';

export class WebSocketTransport implements RpcTransport {
	private url: string;
	constructor(url: string) {
		this.url = url;
	}
	setURL(url: string): void {
		this.url = url;
	}

	connect(handlers: { message: (frame: string) => void; closed: (error?: Error) => void }, signal: AbortSignal): Promise<RpcSession> {
		if (signal.aborted) return Promise.reject(new Error('WebSocket connection closed'));
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(this.url);
			let active = true;
			let opened = false;
			const close = (): void => {
				if (!active) return;
				active = false;
				signal.removeEventListener('abort', close);
				socket.onopen = null;
				socket.onclose = null;
				socket.onerror = null;
				socket.onmessage = null;
				socket.close();
				if (!opened) reject(new Error('WebSocket connection closed'));
			};
			socket.onopen = () => {
				if (!active) return;
				opened = true;
				resolve({ send: frame => socket.send(frame as any), close });
			};
			socket.onmessage = event => {
				if (active) handlers.message(event.data);
			};
			const lost = (): void => {
				if (!active) return;
				const wasOpen = opened;
				close();
				if (wasOpen) handlers.closed(new Error('WebSocket disconnected'));
			};
			socket.onclose = lost;
			socket.onerror = lost;
			signal.addEventListener('abort', close, { once: true });
			if (signal.aborted) close();
		});
	}
}

export class WsClient extends RpcClient {
	private readonly websocket: WebSocketTransport;
	private apiURL: string;
	constructor(apiURL: string, onStateChange: (state: RpcState) => void) {
		const transport = new WebSocketTransport(apiURL);
		super(transport, onStateChange);
		this.websocket = transport;
		this.apiURL = apiURL;
	}
	setAPIURL(apiURL: string): void {
		if (this.apiURL === apiURL) return;
		this.apiURL = apiURL;
		this.websocket.setURL(apiURL);
		this.reconnect();
	}
}
