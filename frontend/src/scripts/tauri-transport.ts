import { encodeIpcBody, IPC_KIND, MAX_API_MESSAGE_SIZE, type RpcSession, type RpcTransport } from '@shared';

export interface NativeFrame {
	session: number;
	sequence: number;
	type: 'message' | 'closed';
	data?: string;
}

export interface TauriHost {
	__BACKEND_IPC__?: boolean;
	__TAURI_INTERNALS__?: { invoke<T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T> };
	__LIBERSHARE_IPC_RECEIVE__?: ((frame: NativeFrame) => void) | undefined;
}

export function isNativeBackend(host: TauriHost | undefined = typeof window === 'undefined' ? undefined : (window as unknown as TauriHost)): boolean {
	return host?.__BACKEND_IPC__ === true;
}

export class TauriTransport implements RpcTransport {
	private readonly host: TauriHost;
	constructor(host: TauriHost = window as unknown as TauriHost) {
		this.host = host;
	}

	async connect(handlers: { message: (frame: string) => void; closed: (error?: Error) => void }, signal: AbortSignal): Promise<RpcSession> {
		if (signal.aborted) throw new Error('Native connection cancelled');
		const bridge = this.host.__TAURI_INTERNALS__;
		if (!bridge) throw new Error('Native backend bridge unavailable');
		let active = true;
		let session: number | undefined;
		let opened = false;
		let lastSequence = 0;
		let bufferedBytes = 0;
		const buffered: NativeFrame[] = [];
		let rejectOpening: (error: Error) => void = () => {};
		const failed = new Promise<never>((_, reject) => {
			rejectOpening = reject;
		});
		const close = (): void => {
			if (!active) return;
			active = false;
			signal.removeEventListener('abort', abort);
			if (this.host.__LIBERSHARE_IPC_RECEIVE__ === receive) this.host.__LIBERSHARE_IPC_RECEIVE__ = undefined;
			buffered.length = 0;
			if (session !== undefined) void bridge.invoke('backend_close', { session }).catch(() => {});
		};
		const abort = (): void => {
			close();
			rejectOpening(new Error('Native connection cancelled'));
		};
		const receive = (frame: NativeFrame): void => {
			if (!active) return;
			if (session === undefined) {
				bufferedBytes += typeof frame.data === 'string' ? frame.data.length * 2 : 0;
				if (buffered.length >= 16 || bufferedBytes > MAX_API_MESSAGE_SIZE) {
					abort();
					return;
				}
				buffered.push(frame);
				return;
			}
			if (frame.session !== session) return;
			try {
				if (frame.sequence > 0 && frame.sequence <= lastSequence) return;
				lastSequence = Math.max(lastSequence, frame.sequence);
				if (frame.type === 'closed') {
					close();
					const error = new Error('Native backend disconnected');
					if (opened) handlers.closed(error);
					else rejectOpening(error);
				} else if (frame.type === 'message' && typeof frame.data === 'string') handlers.message(frame.data);
			} finally {
				if (frame.sequence > 0) void bridge.invoke('backend_ack', { session: frame.session, sequence: frame.sequence }).catch(() => {});
			}
		};
		this.host.__LIBERSHARE_IPC_RECEIVE__ = receive;
		signal.addEventListener('abort', abort, { once: true });
		if (signal.aborted) abort();
		const timeout = setTimeout(() => {
			close();
			rejectOpening(new Error('Native backend startup timed out'));
		}, 10000);
		try {
			const opening = bridge.invoke<number>('backend_open');
			void opening.then(
				value => {
					if (!active) void bridge.invoke('backend_close', { session: value }).catch(() => {});
				},
				() => {}
			);
			session = await Promise.race([opening, failed]);
			if (!active || !Number.isInteger(session) || session <= 0 || session > 0xffffffff) throw new Error('Invalid native session');
			for (const frame of buffered.splice(0)) receive(frame);
			if (!active) throw new Error('Native backend disconnected');
			opened = true;
			return {
				send: frame => {
					if (!active) return Promise.reject(new Error('Native backend disconnected'));
					const payload = typeof frame === 'string' ? new TextEncoder().encode(frame) : frame;
					return bridge.invoke<void>('backend_send', encodeIpcBody(typeof frame === 'string' ? IPC_KIND.Text : IPC_KIND.Binary, session!, payload));
				},
				close,
			};
		} catch (error) {
			close();
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}
}
