import type { Readable, Writable } from 'node:stream';
import { IPC_KIND, IPC_VERSION, IPC_MAX_PAYLOAD_SIZE, encodeIpcFrame, IpcFrameDecoder, type IpcFrame, type IpcKind } from '@shared/ipc-frame.ts';
import type { APIClient } from './client.ts';

const MAX_SESSIONS = 16;
const MAX_QUEUED_FRAMES = 512;
const MAX_QUEUED_BYTES = 2 * (IPC_MAX_PAYLOAD_SIZE + 9);
const MAX_PENDING_REQUESTS = 128;
const MAX_HOST_REQUESTS = 4;

interface Session extends APIClient {
	id: number;
	active: boolean;
	pending: number;
}

interface Callbacks {
	open(client: APIClient): void;
	close(client: APIClient): void;
	message(client: APIClient, message: string | Buffer): Promise<void>;
	disconnect(failed: boolean): void;
}

/** RPC over the parent's private pipes. Session IDs must increase within one child process. */
export class StdioTransport {
	private readonly decoder = new IpcFrameDecoder();
	private readonly sessions = new Map<number, Session>();
	private readonly queue: Array<{ session: number; bytes: Uint8Array }> = [];
	private queuedBytes = 0;
	private writing = false;
	private ended = false;
	private inputEnded = false;
	private draining = false;
	private disconnected = false;
	private failed = false;
	private readySent = false;
	private lastSession = 0;
	private lastHostRequest = 0;
	private readonly hostCalls = new Map<number, { resolve: (reply: string) => void; reject: (error: Error) => void }>();
	private readonly idleWaiters = new Set<() => void>();
	private readonly callbacks: Callbacks;
	private readonly input: Readable;
	private readonly output: Writable;

	constructor(callbacks: Callbacks, input: Readable = process.stdin, output: Writable = process.stdout) {
		this.callbacks = callbacks;
		this.input = input;
		this.output = output;
	}

	start(): void {
		this.input.on('data', this.onData);
		this.input.once('end', this.onEnd);
		this.input.on('error', this.onError);
		this.output.on('error', this.onError);
	}

	ready(): void {
		if (this.ended || this.inputEnded || this.readySent) return;
		this.readySent = true;
		this.enqueue(IPC_KIND.Ready, 0, new Uint8Array([IPC_VERSION]));
	}

	/**
	 * Ask the desktop app for work only its own process may do. The reply settles the promise
	 * whenever the app finishes, so a caller that stops waiting still learns when it ended.
	 */
	hostCall(request: string): Promise<string> {
		if (this.ended || this.inputEnded || !this.readySent) return Promise.reject(new Error('The desktop app is not connected'));
		if (this.hostCalls.size >= MAX_HOST_REQUESTS) return Promise.reject(new Error('Too many desktop app requests'));
		const id = (this.lastHostRequest = (this.lastHostRequest % 0xffffffff) + 1);
		return new Promise((resolve, reject) => {
			this.hostCalls.set(id, { resolve, reject });
			if (!this.enqueue(IPC_KIND.HostRequest, id, Buffer.from(request))) {
				this.hostCalls.delete(id);
				reject(new Error('The desktop app request could not be queued'));
			}
		});
	}

	private readonly onData = (chunk: Buffer): void => {
		if (this.ended || this.inputEnded) return;
		try {
			for (const frame of this.decoder.push(chunk)) this.receive(frame);
		} catch {
			console.error('[IPC] Invalid frame; closing transport');
			this.finish(true);
		}
	};

	private readonly onEnd = (): void => {
		try {
			this.decoder.finish();
			this.beginShutdown();
			this.notifyDisconnect(false);
		} catch {
			console.error('[IPC] Truncated frame at EOF');
			this.finish(true);
		}
	};

	private readonly onError = (): void => {
		console.error('[IPC] Pipe failed');
		this.finish(true);
	};

	private receive(frame: IpcFrame): void {
		if (this.ended || this.inputEnded) return;
		if (!this.readySent || frame.session === 0) throw new Error('Invalid session');
		if (frame.kind === IPC_KIND.HostReply) {
			const call = this.hostCalls.get(frame.session);
			if (!call) throw new Error('Unknown host reply');
			this.hostCalls.delete(frame.session);
			call.resolve(new TextDecoder('utf-8', { fatal: true }).decode(frame.payload));
			return;
		}
		if (frame.kind === IPC_KIND.Open) {
			if (frame.payload.length || frame.session <= this.lastSession || this.sessions.size >= MAX_SESSIONS) throw new Error('Invalid open');
			this.lastSession = frame.session;
			const client: Session = {
				id: frame.session,
				active: true,
				pending: 0,
				data: { subscribedEvents: new Set(), isLocalClient: true },
				send: message => {
					if (!client.active || this.ended) return false;
					const bytes = Buffer.from(message);
					if (bytes.length > IPC_MAX_PAYLOAD_SIZE || !this.enqueue(IPC_KIND.Text, client.id, bytes)) {
						if (this.draining) this.finish(true);
						else this.closeSession(client);
						return false;
					}
					return true;
				},
				close: () => this.closeSession(client),
			};
			this.sessions.set(client.id, client);
			this.callbacks.open(client);
			if (client.active && !this.enqueue(IPC_KIND.Opened, client.id)) this.finish(true);
			return;
		}
		if (frame.kind !== IPC_KIND.Close && frame.kind !== IPC_KIND.Text && frame.kind !== IPC_KIND.Binary) throw new Error('Invalid direction');
		if (frame.kind === IPC_KIND.Close && frame.payload.length) throw new Error('Invalid close');
		const client = this.sessions.get(frame.session);
		// A late frame from a retired window cannot reach the replacement session.
		if (!client) {
			if (frame.session <= this.lastSession) return;
			throw new Error('Unknown session');
		}
		if (frame.kind === IPC_KIND.Close) {
			this.closeSession(client);
			return;
		}
		if (client.pending >= MAX_PENDING_REQUESTS) {
			this.closeSession(client);
			return;
		}
		client.pending++;
		const message = frame.kind === IPC_KIND.Text ? new TextDecoder('utf-8', { fatal: true }).decode(frame.payload) : Buffer.from(frame.payload);
		void this.callbacks
			.message(client, message)
			.catch(() => {
				console.error('[IPC] Request failed');
				this.closeSession(client);
			})
			.finally(() => client.pending--);
	}

	private closeSession(client: Session, notify = true): void {
		if (!client.active) return;
		client.active = false;
		this.sessions.delete(client.id);
		for (let index = this.queue.length - 1; index >= 0; index--) {
			if (this.queue[index]!.session !== client.id) continue;
			this.queuedBytes -= this.queue[index]!.bytes.length;
			this.queue.splice(index, 1);
		}
		this.callbacks.close(client);
		if (notify && !this.ended && !this.enqueue(IPC_KIND.Close, client.id)) this.finish(true);
	}

	private enqueue(kind: IpcKind, session: number, payload: Uint8Array = new Uint8Array(0)): boolean {
		const size = 9 + payload.length;
		if (this.ended || this.queue.length >= MAX_QUEUED_FRAMES || this.queuedBytes + size > MAX_QUEUED_BYTES) return false;
		const bytes = encodeIpcFrame(kind, session, payload);
		this.queue.push({ session, bytes });
		this.queuedBytes += bytes.length;
		this.pump();
		return true;
	}

	private pump(): void {
		if (this.writing || this.ended) return;
		const next = this.queue.shift();
		if (!next) {
			for (const resolve of this.idleWaiters) resolve();
			this.idleWaiters.clear();
			return;
		}
		this.writing = true;
		try {
			this.output.write(next.bytes, error => {
				this.queuedBytes = Math.max(0, this.queuedBytes - next.bytes.length);
				this.writing = false;
				if (error) this.finish(true);
				else this.pump();
			});
		} catch {
			this.queuedBytes = Math.max(0, this.queuedBytes - next.bytes.length);
			this.writing = false;
			this.finish(true);
		}
	}

	private stopInput(): void {
		this.inputEnded = true;
		// No reply can arrive any more; a caller must not wait for one.
		for (const call of this.hostCalls.values()) call.reject(new Error('The desktop app disconnected'));
		this.hostCalls.clear();
		this.input.off('data', this.onData);
		this.input.off('end', this.onEnd);
		this.input.pause();
	}

	/** The API owns the drain; accepted requests keep their session and upload ownership. */
	beginShutdown(): void {
		this.draining = true;
		this.stopInput();
	}

	private notifyDisconnect(failed: boolean): void {
		if (this.failed || (this.disconnected && !failed)) return;
		this.disconnected = true;
		this.failed ||= failed;
		this.callbacks.disconnect(failed);
	}

	private finish(failed: boolean): void {
		if (this.ended) {
			this.notifyDisconnect(failed);
			return;
		}
		this.ended = true;
		this.stopInput();
		if (!this.draining) for (const client of this.sessions.values()) this.closeSession(client, false);
		this.queue.length = 0;
		this.queuedBytes = 0;
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters.clear();
		this.notifyDisconnect(failed);
	}

	async stop(): Promise<void> {
		this.beginShutdown();
		// The API has drained accepted handlers; deliver their queued replies before Close.
		if (!this.ended && (this.writing || this.queue.length)) await new Promise<void>(resolve => this.idleWaiters.add(resolve));
		for (const client of this.sessions.values()) this.closeSession(client);
		if (!this.ended && (this.writing || this.queue.length)) await new Promise<void>(resolve => this.idleWaiters.add(resolve));
		this.ended = true;
		this.input.off('data', this.onData);
		this.input.off('end', this.onEnd);
		this.input.off('error', this.onError);
		this.input.pause();
	}
}
