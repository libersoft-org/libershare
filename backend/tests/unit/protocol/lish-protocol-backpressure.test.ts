import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { AbstractStream, type SendResult } from '@libp2p/utils';
import { encode as lpEncode } from 'it-length-prefixed';
import { encode as codecEncode } from '../../../src/protocol/codec.ts';
import { enableUpload, handleLISHProtocol, resetUploadState } from '../../../src/protocol/lish-protocol.ts';
import { DEFAULT_MAX_CHUNK_SIZE, DEFAULT_MAX_MESSAGE_SIZE, useNetworkSettings, type SettingsData } from '../../../src/settings.ts';
import type { DataServer } from '../../../src/lish/data-server.ts';

/**
 * The responder takes the next request only after the previous reply has left its write queue,
 * so a peer that pipelines requests — or never reads — cannot make it hold every reply at once.
 * Runs on the real AbstractStream write queue: a mock of `send()` would hide how the library
 * signals that the queue emptied.
 */

useNetworkSettings(() => ({ maxUploadPeersPerLISH: 0, maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE, maxChunkSize: DEFAULT_MAX_CHUNK_SIZE }) as unknown as SettingsData['network']);

/** A stream whose outgoing window the test opens; nothing leaves while the window is shut. */
class WindowedStream extends AbstractStream {
	private window = 0;
	constructor() {
		super({ id: 'windowed', log: Object.assign(() => {}, { error() {}, trace() {} }) as never });
	}
	/** Let `bytes` more out, the way a muxer window update does. */
	open(bytes: number): void {
		this.window += bytes;
		this.safeDispatchEvent('drain');
	}
	/** Deliver request frames as if they arrived from the peer. */
	receive(...requests: unknown[]): void {
		for (const request of requests) this.receiveRaw(codecEncode(request));
	}
	/** Deliver a frame with any payload, readable as a request or not. */
	receiveRaw(payload: Uint8Array): void {
		this.onData(lpEncode.single(payload).subarray());
	}
	sendData(data: { byteLength: number }): SendResult {
		const sentBytes = Math.min(this.window, data.byteLength);
		this.window -= sentBytes;
		return { sentBytes, canSendMore: this.window > 0 };
	}
	sendReset(): void {}
	sendPause(): void {}
	sendResume(): void {}
	async sendCloseWrite(): Promise<void> {}
	async sendCloseRead(): Promise<void> {}
}

const LISH = 'lish-backpressure';
const CHUNK = new Uint8Array(256 * 1024).fill(9);

function dataServer(answer: () => Uint8Array | string = () => CHUNK): { server: DataServer; chunks: () => number; lists: () => number } {
	let chunks = 0;
	let lists = 0;
	const server = {
		getChunk: async () => {
			chunks++;
			return answer();
		},
		list: () => {
			lists++;
			return [];
		},
		findChunkFile: () => undefined,
		incrementUploadedBytes: () => {},
	} as unknown as DataServer;
	return { server, chunks: () => chunks, lists: () => lists };
}

async function until(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5);
}

beforeEach(() => enableUpload(LISH));
afterEach(() => resetUploadState());

describe('LISH responder backpressure', () => {
	it('holds one queued and one prepared chunk while the previous reply has not left the queue', async () => {
		const stream = new WindowedStream();
		const { server, chunks } = dataServer();
		const handler = handleLISHProtocol(stream, server);
		stream.receive(...[1, 2, 3, 4].map(i => ({ type: 'getChunk', lishID: LISH, chunkID: `c${i}` })));
		await until(() => chunks() > 1);
		await Bun.sleep(50);
		// The first reply sits in the shut window; the second chunk is read from disk ahead of time.
		expect(chunks()).toBe(2);
		stream.open(64 * 1024 * 1024);
		await until(() => chunks() === 4);
		expect(chunks()).toBe(4);
		stream.abort(new Error('test done'));
		await handler;
	});

	it('holds back small replies the same way', async () => {
		const stream = new WindowedStream();
		const { server, lists } = dataServer();
		const handler = handleLISHProtocol(stream, server);
		stream.receive(...[1, 2, 3].map(() => ({ type: 'getLishs' })));
		await until(() => lists() > 1);
		await Bun.sleep(50);
		// One listing waits in the shut window, the next one is prepared.
		expect(lists()).toBe(2);
		stream.open(1024 * 1024);
		await until(() => lists() === 3);
		expect(lists()).toBe(3);
		stream.abort(new Error('test done'));
		await handler;
	});

	it('ends the handler when the stream closes while a reply is queued', async () => {
		const stream = new WindowedStream();
		const { server, chunks } = dataServer();
		const handler = handleLISHProtocol(stream, server);
		stream.receive({ type: 'getChunk', lishID: LISH, chunkID: 'c1' }, { type: 'getChunk', lishID: LISH, chunkID: 'c2' });
		await until(() => chunks() > 0);
		stream.abort(new Error('peer gone'));
		const finished = await Promise.race([handler.then(() => true), Bun.sleep(1000).then(() => false)]);
		expect(finished).toBe(true);
		expect(chunks()).toBeLessThanOrEqual(2);
	});
	// Error replies are small, but a peer that never reads could otherwise queue one per request.
	const errorCases: Array<[string, (stream: WindowedStream) => void, () => Uint8Array | string]> = [
		['a chunk the seeder does not have', stream => stream.receive(...Array.from({ length: 100 }, (_, i) => ({ type: 'getChunk', lishID: LISH, chunkID: `c${i}` }))), () => 'chunk_not_found'],
		['a LISH that is not shared', stream => stream.receive(...Array.from({ length: 100 }, (_, i) => ({ type: 'getChunk', lishID: 'lish-not-shared', chunkID: `c${i}` }))), () => CHUNK],
		['an unreadable request', stream => Array.from({ length: 100 }, () => stream.receiveRaw(new Uint8Array([0xc1]))), () => CHUNK],
	];
	for (const [name, send, answer] of errorCases) {
		it(`holds back error replies for ${name}`, async () => {
			const stream = new WindowedStream();
			const { server } = dataServer(answer);
			const handler = handleLISHProtocol(stream, server);
			send(stream);
			await until(() => stream.writeBufferLength > 0);
			await Bun.sleep(50);
			const queued = stream.writeBufferLength;
			// Only the first reply is queued; with every reply queued this would be about 100 times as much.
			await Bun.sleep(50);
			expect(stream.writeBufferLength).toBe(queued);
			expect(queued).toBeLessThan(100);
			stream.abort(new Error('test done'));
			await handler;
		});
	}
});
