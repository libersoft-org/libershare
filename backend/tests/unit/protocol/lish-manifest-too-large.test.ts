import { describe, expect, it } from 'bun:test';
import { encode as lpEncode, decode as lpDecode } from 'it-length-prefixed';
import { Uint8ArrayList } from 'uint8arraylist';
import { CodedError, ErrorCodes, type IStoredLISH } from '@shared';
import { encode as codecEncode, decode as codecDecode } from '../../../src/protocol/codec.ts';
import { LISHClient, getEnabledUploads, handleLISHProtocol, removeUploadState } from '../../../src/protocol/lish-protocol.ts';
import { useNetworkSettings, type SettingsData } from '../../../src/settings.ts';

/**
 * A node whose message limit is below a manifest's size cannot send it. It must answer with a
 * coded refusal instead of resetting the stream, which the asking peer could only read as
 * "unreachable", and the asking side must see that code.
 */

// The effective limit is max(maxMessageSize, maxChunkSize + 1 MiB headroom), so about 1 MiB here.
useNetworkSettings(() => ({ maxDownloadSpeed: 0, maxUploadSpeed: 0, maxDownloadPeersPerLISH: 30, maxUploadPeersPerLISH: 30, maxMessageSize: 64 * 1024, maxChunkSize: 1024 }) as SettingsData['network']);

const LISH_ID = 'b1000000-0000-4000-8000-000000000001';

function manifestOf(checksums: number): IStoredLISH {
	return { id: LISH_ID, name: 'Big', created: '2026-11-08T10:00:00.000Z', chunkSize: 1024, checksumAlgo: 'sha256', directory: '/data/big', files: [{ path: 'big.bin', size: checksums * 1024, checksums: Array.from({ length: checksums }, (_, i) => i.toString(16).padStart(64, '0')) }] };
}

/** Serve one getLish request and return the decoded reply and whether the stream was aborted. */
async function serve(lish: IStoredLISH): Promise<{ reply: Record<string, unknown>; aborted: boolean }> {
	const sent = new Uint8ArrayList();
	let aborted = false;
	const request = lpEncode.single(codecEncode({ type: 'getLish', lishID: LISH_ID })).subarray();
	const stream = {
		status: 'open',
		async *[Symbol.asyncIterator]() {
			yield request;
		},
		send(data: Uint8Array | Uint8ArrayList) {
			sent.append(data);
			return true;
		},
		abort() {
			aborted = true;
			this.status = 'aborted';
		},
		close: async () => {},
	} as any;
	getEnabledUploads().add(LISH_ID);
	try {
		await handleLISHProtocol(
			stream,
			{ get: () => lish } as any,
			'peer-big',
			'DIRECT',
			() => true,
			() => true
		);
	} finally {
		removeUploadState(LISH_ID);
	}
	const frames: Uint8Array[] = [];
	for await (const frame of lpDecode([sent.subarray()], { maxDataLength: 64 * 1024 * 1024 })) frames.push(frame.subarray());
	expect(frames).toHaveLength(1);
	return { reply: codecDecode(frames[0]!) as Record<string, unknown>, aborted };
}

describe('a manifest over the sender message limit', () => {
	it('is refused with PEER_MANIFEST_TOO_LARGE and the stream stays usable', async () => {
		const { reply, aborted } = await serve(manifestOf(20_000));
		expect(reply).toEqual({ error: ErrorCodes.PEER_MANIFEST_TOO_LARGE });
		expect(aborted).toBe(false);
	});

	it('under the limit is still sent whole', async () => {
		const { reply, aborted } = await serve(manifestOf(10));
		expect((reply['manifest'] as IStoredLISH | undefined)?.id).toBe(LISH_ID);
		expect(aborted).toBe(false);
	});

	it('reaches the asking side as its own code', async () => {
		const frame = lpEncode.single(codecEncode({ error: ErrorCodes.PEER_MANIFEST_TOO_LARGE })).subarray();
		const client = new LISHClient({
			status: 'open',
			send() {},
			close: async () => {},
			async *[Symbol.asyncIterator]() {
				yield frame;
			},
		} as any);
		const error = await client.requestManifest(LISH_ID as never).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CodedError);
		expect((error as CodedError).code).toBe(ErrorCodes.PEER_MANIFEST_TOO_LARGE);
	});
});
