import { describe, it, expect } from 'bun:test';
import { encode as lpEncode } from 'it-length-prefixed';
import { Uint8ArrayList } from 'uint8arraylist';
import { CodedError, ErrorCodes } from '@shared';
import { LISHClient, type LISHGetLishResponse } from '../../../src/protocol/lish-protocol.ts';
import { encode as codecEncode, decode as codecDecode } from '../../../src/protocol/codec.ts';
import { createTestDB, createTestLISH, TEST_LISH_ID, TEST_LISH_ID_2, TEST_CHUNK_IDS } from '../helpers/fixtures.ts';
import { addLISH, getLISH, getMissingChunks, markChunkDownloaded } from '../../../src/db/lishs.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake libp2p stream that replies with one length-prefixed msgpack frame. */
function makeStream(frame: Uint8Array): any {
	return {
		status: 'open',
		send(): void {},
		async close(): Promise<void> {},
		async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
			yield frame;
		},
	};
}

/** Encode a `{ manifest }` response both framed (for the stream) and raw (for the control). */
function manifestResponse(manifest: unknown): { frame: Uint8Array; data: Uint8Array } {
	const data = codecEncode({ manifest });
	const prefixed = lpEncode.single(data);
	return { frame: prefixed instanceof Uint8Array ? prefixed : (prefixed as Uint8ArrayList).subarray(), data };
}

/**
 * The receive path as it behaved before the id check: parse the response and hand the
 * manifest back untouched. Kept here as the negative control — every mismatch assertion
 * below is also run against this to prove it would have failed before the fix.
 */
function legacyReadManifest(data: Uint8Array): { id: string } {
	const response = codecDecode(data) as LISHGetLishResponse;
	if (!('manifest' in response)) throw new Error('missing manifest');
	return response.manifest as unknown as { id: string };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LISHClient.requestManifest – manifest id check', () => {
	it('rejects a manifest whose id differs from the requested lishID', async () => {
		const { frame, data } = manifestResponse(createTestLISH({ id: TEST_LISH_ID_2 }));
		const client = new LISHClient(makeStream(frame));

		const error = await client.requestManifest(TEST_LISH_ID).then(
			() => null,
			(e: unknown) => e
		);

		expect(error).toBeInstanceOf(CodedError);
		expect((error as CodedError).code).toBe(ErrorCodes.PEER_INVALID_REQUEST);
		// Negative control: the pre-fix receive path returned the foreign manifest instead.
		expect(legacyReadManifest(data).id).toBe(TEST_LISH_ID_2);
	});

	it('rejects a manifest with no id at all', async () => {
		const { id: _id, ...noID } = createTestLISH(TEST_LISH_ID);
		const { frame, data } = manifestResponse(noID);
		const client = new LISHClient(makeStream(frame));

		const error = await client.requestManifest(TEST_LISH_ID).then(
			() => null,
			(e: unknown) => e
		);

		expect((error as CodedError).code).toBe(ErrorCodes.PEER_INVALID_REQUEST);
		// Negative control: previously an id-less manifest reached the caller unchallenged.
		expect(legacyReadManifest(data).id).toBeUndefined();
	});

	it('does not echo a huge peer-supplied id into the error message', async () => {
		// The id is peer-controlled and bounded only by the message size limit, so the
		// rejection must not copy it whole into an error that later layers log or forward.
		const hostile = 'A'.repeat(100_000);
		const client = new LISHClient(makeStream(manifestResponse(createTestLISH({ id: hostile })).frame));

		const error = await client.requestManifest(TEST_LISH_ID).then(
			() => null,
			(e: unknown) => e
		);

		expect((error as CodedError).code).toBe(ErrorCodes.PEER_INVALID_REQUEST);
		expect(String((error as CodedError).message).length).toBeLessThan(500);
	});

	it('accepts the manifest of the requested LISH', async () => {
		const client = new LISHClient(makeStream(manifestResponse(createTestLISH(TEST_LISH_ID)).frame));

		const manifest = await client.requestManifest(TEST_LISH_ID);

		expect(manifest.id).toBe(TEST_LISH_ID);
	});

	it('a foreign manifest overwrites the other LISH row when it is not rejected', () => {
		// Why the check is a MUST: callers persist the manifest under the id it carries, and
		// that insert is an upsert. This is the damage the rejection above prevents.
		const db = createTestDB();
		addLISH(db, createTestLISH({ id: TEST_LISH_ID_2, name: 'Shared', directory: '/data/shared', finalDirectory: '/data/finished' }));
		for (const chunk of TEST_CHUNK_IDS) markChunkDownloaded(db, TEST_LISH_ID_2, chunk);
		expect(getMissingChunks(db, TEST_LISH_ID_2)).toHaveLength(0);

		// Downloader for TEST_LISH_ID does: { ...manifest, directory: downloadDir } → dataServer.add()
		const foreign = createTestLISH({ id: TEST_LISH_ID_2, name: 'foreign', files: [{ path: 'other.bin', size: 10, checksums: [TEST_CHUNK_IDS[0]] }] });
		addLISH(db, { ...foreign, directory: '/tmp/download-temp' });

		const victim = getLISH(db, TEST_LISH_ID_2);
		expect(victim?.name).toBe('foreign');
		expect(victim?.directory).toBe('/tmp/download-temp');
		expect(victim?.finalDirectory).toBeUndefined();
		expect(victim?.files).toHaveLength(1);
		expect(getMissingChunks(db, TEST_LISH_ID_2)).toHaveLength(1);
	});
});
