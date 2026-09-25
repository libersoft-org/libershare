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
