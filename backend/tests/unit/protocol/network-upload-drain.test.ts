import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { encode as lpEncode } from 'it-length-prefixed';
import { encode as codecEncode } from '../../../src/protocol/codec.ts';
import { Network } from '../../../src/protocol/network.ts';
import { enableUpload, resetUploadState } from '../../../src/protocol/lish-protocol.ts';
import { DEFAULT_MAX_CHUNK_SIZE, DEFAULT_MAX_MESSAGE_SIZE, useNetworkSettings, type SettingsData } from '../../../src/settings.ts';

useNetworkSettings(
	() =>
		({
			maxDownloadSpeed: 0,
			maxUploadSpeed: 0,
			maxDownloadPeersPerLISH: 30,
			maxUploadPeersPerLISH: 1,
			maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE,
			maxChunkSize: DEFAULT_MAX_CHUNK_SIZE,
		}) as SettingsData['network']
);

class BlockingStream {
	readonly id = 'reset-upload-stream';
	status = 'open';
	aborted = false;
	readonly sent: Uint8Array[] = [];
	private readonly frame: Uint8Array;

	constructor(request: unknown) {
		this.frame = lpEncode.single(codecEncode(request)).subarray();
	}

	send(data: Uint8Array): void {
		this.sent.push(data);
	}

	async close(): Promise<void> {
		this.status = 'closed';
	}

	abort(): void {
		this.aborted = true;
		this.status = 'closed';
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
		yield this.frame;
	}
}

describe('Network inbound upload reset drain', () => {
	beforeEach(() => resetUploadState());
	afterEach(() => resetUploadState());

	it('aborts an admitted handler and waits for its pending disk read before returning', async () => {
		let readStarted!: () => void;
		let releaseRead!: () => void;
		const readEntered = new Promise<void>(resolve => {
			readStarted = resolve;
		});
		const readBlocked = new Promise<void>(resolve => {
			releaseRead = resolve;
		});
		const dataServer = {
			getChunk: async () => {
				readStarted();
				await readBlocked;
				return new Uint8Array([1, 2, 3]);
			},
		};
		const network = new Network('/tmp/network-upload-drain', dataServer as never, {} as never);
		const internals = network as unknown as Record<string, any>;
		internals['node'] = {};
		internals['sharesJoinedTopicWith'] = () => true;
		internals['canListSharesTo'] = () => true;
		const stream = new BlockingStream({ type: 'getChunk', lishID: 'reset-upload', chunkID: 'chunk-a' });
		enableUpload('reset-upload');

		const handling = internals['handleInboundLISHProtocol']({
			stream,
			connection: { remotePeer: { toString: () => 'peer-reset-upload' } },
		}) as Promise<void>;
		await readEntered;
		let drained = false;
		const pausing = network.pauseLISHProtocolHandlersAndDrain().then(() => {
			drained = true;
		});
		await Promise.resolve();

		expect(stream.aborted).toBe(true);
		expect(drained).toBe(false);
		expect(stream.sent).toHaveLength(0);

		releaseRead();
		await Promise.all([handling, pausing]);

		expect(stream.sent).toHaveLength(0);
		expect(internals['activeLISHProtocolHandlers'].size).toBe(0);
		expect(internals['activeLISHProtocolStreams'].size).toBe(0);
		network.resumeLISHProtocolHandlers();
	});
});
