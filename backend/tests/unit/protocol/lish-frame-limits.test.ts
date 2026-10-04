import { describe, expect, it } from 'bun:test';
import { CodedError, ErrorCodes } from '@shared';
import { LISHClient, handleLISHProtocol } from '../../../src/protocol/lish-protocol.ts';
import { MAX_ACK_RESPONSE_SIZE, MAX_INBOUND_MESSAGE_SIZE, MAX_LIST_RESPONSE_SIZE } from '../../../src/protocol/constants.ts';

/**
 * A frame is refused by its length prefix, before its body is read: a reply is bounded by what
 * was asked for, and everything a peer sends us unasked by one common cap.
 */
function varint(value: number): Uint8Array {
	const out: number[] = [];
	while (value >= 0x80) {
		out.push((value % 0x80) | 0x80);
		value = Math.floor(value / 0x80);
	}
	out.push(value);
	return new Uint8Array(out);
}

/** A stream that delivers only the length prefix of a frame and then never ends. */
function headerOnly(length: number): { stream: any; aborted: () => Error | undefined; sent: () => number } {
	let abortError: Error | undefined;
	let sent = 0;
	let wake!: () => void;
	const stream = {
		status: 'open',
		send() {
			sent++;
		},
		close: async () => {},
		abort(error: Error) {
			abortError = error;
			this.status = 'aborted';
			wake?.();
		},
		async *[Symbol.asyncIterator]() {
			yield varint(length);
			await new Promise<void>(resolve => (wake = resolve));
		},
	};
	return { stream, aborted: () => abortError, sent: () => sent };
}

async function codedError(promise: Promise<unknown>): Promise<CodedError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof CodedError) return error;
		throw error;
	}
	throw new Error('expected a rejection');
}

describe('LISHClient reply limits', () => {
	it('refuses a list reply longer than the list limit from its length prefix', async () => {
		const peer = headerOnly(MAX_LIST_RESPONSE_SIZE + 1);
		const error = await codedError(new LISHClient(peer.stream).requestList());
		expect(error.code).toBe(ErrorCodes.PEER_INVALID_REQUEST);
		expect(error.message).toContain('getLishs: reply of');
		expect(peer.aborted()).toBeDefined();
	});

	it('refuses an acknowledgement longer than the ack limit', async () => {
		const peer = headerOnly(MAX_ACK_RESPONSE_SIZE + 1);
		expect((await codedError(new LISHClient(peer.stream).announceHave('lish-a' as any, 'all', []))).code).toBe(ErrorCodes.PEER_INVALID_REQUEST);
		expect(peer.aborted()).toBeDefined();
		const search = headerOnly(MAX_ACK_RESPONSE_SIZE + 1);
		expect((await codedError(new LISHClient(search.stream).sendSearchResult('s', []))).code).toBe(ErrorCodes.PEER_INVALID_REQUEST);
	});

	it('refuses a chunk reply past the chunk limit', async () => {
		// Past the chunk limit (100 MiB + headroom) but under the 128 MiB message limit.
		const peer = headerOnly(110 * 1024 * 1024);
		const error = await codedError(new LISHClient(peer.stream).requestChunk('lish-a' as any, 'c1' as any));
		expect(error.code).toBe(ErrorCodes.PEER_INVALID_REQUEST);
		expect(peer.aborted()).toBeDefined();
	});
});

describe('announcements past the inbound cap', () => {
	it('are refused before sending, with an explicit error', async () => {
		const peer = headerOnly(1);
		const checksums = Array.from({ length: Math.ceil(MAX_INBOUND_MESSAGE_SIZE / 64) }, (_, i) => `${i}`.padStart(64, '0'));
		const error = await codedError(new LISHClient(peer.stream).announceHave('lish-a' as any, checksums as any, []));
		expect(error.code).toBe(ErrorCodes.MESSAGE_TOO_LARGE);
		expect(peer.sent()).toBe(0);
	});
});

describe('handleLISHProtocol inbound cap', () => {
	it('drops a stream whose frame is longer than the inbound cap without reading it', async () => {
		const peer = headerOnly(MAX_INBOUND_MESSAGE_SIZE + 1);
		await handleLISHProtocol(peer.stream, {} as any, 'peer-id', 'DIRECT');
		expect(peer.aborted()).toBeDefined();
		expect(peer.sent()).toBe(0);
	});
});
