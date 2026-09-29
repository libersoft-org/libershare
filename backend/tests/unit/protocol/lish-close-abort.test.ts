import { expect, it } from 'bun:test';
import { AbstractStream, type SendResult } from '@libp2p/utils';
import type { AbortOptions } from '@libp2p/interface';
import { LISHClient, handleLISHProtocol } from '../../../src/protocol/lish-protocol.ts';
import type { DataServer } from '../../../src/lish/data-server.ts';

class BackpressuredStream extends AbstractStream {
	onClosing: (() => void) | undefined;
	constructor() {
		super({ id: 'blocked-write', log: Object.assign(() => {}, { error() {}, trace() {} }) as never });
		this.send(new Uint8Array([1]));
	}
	sendData(): SendResult {
		return { sentBytes: 0, canSendMore: false };
	}
	sendReset(): void {}
	sendPause(): void {}
	sendResume(): void {}
	async sendCloseWrite(): Promise<void> {}
	async sendCloseRead(): Promise<void> {}
	override close(options?: AbortOptions): Promise<void> {
		this.onClosing?.();
		return super.close(options);
	}
}

async function settled(operation: Promise<void>): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation.then(() => true),
			new Promise<false>(resolve => {
				timer = setTimeout(() => resolve(false), 100);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

it('aborts client close while the real stream waits for its write queue', async () => {
	const stream = new BackpressuredStream();
	const client = new LISHClient(stream);
	const closing = client.close();
	client.abort(new Error('network stopping'));
	try {
		expect(await settled(closing)).toBe(true);
	} finally {
		// Releases the unfixed upstream drain wait after the assertion has failed.
		stream.dispatchEvent(new Event('drain'));
		await closing;
	}
});

it('drains an inbound handler whose final close races with network shutdown', async () => {
	const stream = new BackpressuredStream();
	const closing = new Promise<void>(resolve => {
		stream.onClosing = resolve;
	});
	const abort = new AbortController();
	const handler = handleLISHProtocol(stream, {} as DataServer, undefined, undefined, undefined, undefined, abort.signal);
	stream.onRemoteCloseWrite();
	await closing;
	abort.abort(new Error('network stopping'));
	stream.abort(new Error('network stopping'));
	try {
		expect(await settled(handler)).toBe(true);
	} finally {
		stream.dispatchEvent(new Event('drain'));
		await handler;
	}
});
