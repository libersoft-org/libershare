import { afterEach, describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { Network } from '../../../src/protocol/network.ts';
import { enableUpload, resetUploadState } from '../../../src/protocol/lish-protocol.ts';

/**
 * A HAVE reply to a pubsub WANT runs outside the inbound LISH handlers: it dials the asker and
 * waits for its acknowledgement. Stop and reset must end it and wait for it like the inbound
 * handlers, so it cannot write the cooldown map after that map was cleared for the next run.
 */
class SilentPeerStream {
	status = 'open';
	aborted = false;
	readonly sent: Uint8Array[] = [];
	private wake: (() => void) | undefined;

	send(data: Uint8Array): void {
		this.sent.push(data);
	}

	async close(): Promise<void> {
		this.status = 'closed';
	}

	abort(): void {
		this.aborted = true;
		this.status = 'aborted';
		this.wake?.();
	}

	// Never acknowledges: the read ends only when the stream is aborted.
	async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
		await new Promise<void>(resolve => (this.wake = resolve));
	}
}

describe('pubsub WANT replies and the reset drain', () => {
	afterEach(() => resetUploadState());

	it('aborts a reply waiting for its ACK, waits for it, and records no cooldown', async () => {
		const LISH = 'pubsub-drain-lish';
		const dataServer = { get: () => ({ id: LISH, directory: tmpdir(), files: [] }), getHaveChunks: () => 'all' };
		const network = new Network('/tmp/pubsub-reply-drain', dataServer as never, {} as never);
		const internals = network as unknown as Record<string, any>;
		internals['node'] = { peerId: { toString: () => 'self' }, getMultiaddrs: () => [] };
		const streams: SilentPeerStream[] = [];
		let dialSignal: AbortSignal | undefined;
		internals['dialProtocolByPeerId'] = async (_peer: string, _protocol: string, signal?: AbortSignal) => {
			dialSignal = signal;
			const stream = new SilentPeerStream();
			streams.push(stream);
			return { stream };
		};
		enableUpload(LISH);

		internals['lishHandlers'].dispatchWant({ type: 'want', lishID: LISH }, 'net-a', 'peer-asker');
		for (let i = 0; i < 100 && streams[0]?.sent.length !== 1; i++) await Bun.sleep(5);
		expect(streams[0]?.sent).toHaveLength(1);

		const started = Date.now();
		await network.pauseLISHProtocolHandlersAndDrain();
		// Without the abort the reply would sit out its 15 s ACK timeout.
		expect(Date.now() - started).toBeLessThan(2000);
		expect(streams[0]!.aborted).toBe(true);
		expect(dialSignal?.aborted).toBe(true);
		expect(internals['lastWantResponseTime'].size).toBe(0);

		// Closed until resumed: a WANT arriving now is not answered.
		internals['lishHandlers'].dispatchWant({ type: 'want', lishID: LISH }, 'net-a', 'peer-late');
		await Bun.sleep(20);
		expect(streams).toHaveLength(1);

		network.resumeLISHProtocolHandlers();
		internals['lishHandlers'].dispatchWant({ type: 'want', lishID: LISH }, 'net-a', 'peer-next');
		for (let i = 0; i < 100 && streams.length < 2; i++) await Bun.sleep(5);
		expect(streams).toHaveLength(2);
		await network.pauseLISHProtocolHandlersAndDrain();
		network.resumeLISHProtocolHandlers();
	});
});

/** Acknowledges the first message, then never finishes a graceful close until aborted. */
class StuckClosingStream {
	status = 'open';
	aborted = false;
	readonly sent: Uint8Array[] = [];
	private wakeRead: (() => void) | undefined;
	private wakeClose: (() => void) | undefined;

	send(data: Uint8Array): void {
		this.sent.push(data);
		this.wakeRead?.();
	}

	close(): Promise<void> {
		return new Promise(resolve => (this.wakeClose = resolve));
	}

	abort(): void {
		this.aborted = true;
		this.status = 'aborted';
		this.wakeRead?.();
		this.wakeClose?.();
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
		while (this.sent.length === 0 && !this.aborted) await new Promise<void>(resolve => (this.wakeRead = resolve));
		if (this.aborted) return;
		const { encode: lp } = await import('it-length-prefixed');
		const { encode } = await import('../../../src/protocol/codec.ts');
		yield lp.single(encode({ ok: true })).subarray();
		while (!this.aborted) await new Promise<void>(resolve => (this.wakeRead = resolve));
	}
}

describe('pubsub search replies and the reset drain', () => {
	afterEach(() => resetUploadState());

	it('aborts a reply whose close is stuck, instead of waiting on it', async () => {
		const LISH = 'pubsub-drain-search';
		const dataServer = { list: () => [{ id: LISH, name: 'Shared', files: [{ size: 1 }] }] };
		const network = new Network('/tmp/pubsub-search-drain', dataServer as never, {} as never);
		const internals = network as unknown as Record<string, any>;
		internals['node'] = { peerId: { toString: () => 'self' }, getMultiaddrs: () => [] };
		internals['canServePubsubRequestTo'] = () => true;
		internals['isDirectPeer'] = () => true;
		internals['isJoinedToLishnet'] = () => true;
		const stream = new StuckClosingStream();
		internals['dialProtocolByPeerId'] = async () => ({ stream });
		enableUpload(LISH);

		internals['lishHandlers'].dispatchSearch({ type: 'searchLishs', searchID: 'search-drain', query: 'shared' }, 'net-a', 'peer-asker');
		for (let i = 0; i < 100 && stream.sent.length === 0; i++) await Bun.sleep(5);
		expect(stream.sent).toHaveLength(1);
		await Bun.sleep(20);

		const started = Date.now();
		await network.pauseLISHProtocolHandlersAndDrain();
		expect(Date.now() - started).toBeLessThan(2000);
		expect(stream.aborted).toBe(true);
		network.resumeLISHProtocolHandlers();
	});
});
