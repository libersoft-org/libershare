import { beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DataServer } from '../../../src/lish/data-server.ts';
import { handleLISHProtocol, initUploadState, resetUploadState } from '../../../src/protocol/lish-protocol.ts';
import { isSearchAdvertisableLish } from '../../../src/protocol/network.ts';
import { addLISH, markChunkDownloaded } from '../../../src/db/lishs.ts';
import { clearBusy, setBusy } from '../../../src/api/busy.ts';
import { createTestDB, createTestLISH, populateTestDB, TEST_CHUNK_IDS, TEST_LISH_ID } from '../helpers/fixtures.ts';
import { decodeLISHResponses, fakeLISHStream } from '../helpers/lish-stream.ts';
import { ErrorCodes } from '@shared';

const LISHS_API_TS = readFileSync(join(__dirname, '../../../src/api/lishs.ts'), 'utf-8');

/** Serve-gate stand-ins. The gate's own logic lives in serve-gate.test.ts. */
const allowAll = (): boolean => true;
const refuseAll = (): boolean => false;

/**
 * A LISH the handler will actually serve a manifest for. The default fixture has no
 * `directory`, which getLish treats as inconsistent local state and refuses with the same
 * code as a gate rejection — so a gate test built on it would pass for the wrong reason.
 */
function servableDB(): ReturnType<typeof createTestDB> {
	const db = createTestDB();
	addLISH(db, createTestLISH({ id: TEST_LISH_ID, directory: 'test-data-dir' }));
	return db;
}

describe('LISH search visibility', () => {
	beforeEach(() => {
		resetUploadState();
		clearBusy(TEST_LISH_ID);
	});

	it('does not advertise upload-enabled LISH while verification is still running', () => {
		const db = createTestDB();
		populateTestDB(db);
		const dataServer = new DataServer(db);
		initUploadState(new Set([TEST_LISH_ID]), () => {});
		setBusy(TEST_LISH_ID, 'verifying');

		const lish = dataServer.list()[0]!;
		expect(isSearchAdvertisableLish(lish)).toBe(false);
	});

	it('advertises partial LISH after verification is no longer busy', () => {
		const db = createTestDB();
		populateTestDB(db);
		const dataServer = new DataServer(db);
		initUploadState(new Set([TEST_LISH_ID]), () => {});

		markChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[0]);

		const lish = dataServer.list()[0]!;
		expect(isSearchAdvertisableLish(lish)).toBe(true);
	});

	it('withholds the listing from a peer the gate refuses', async () => {
		const db = createTestDB();
		populateTestDB(db);
		const dataServer = new DataServer(db);
		initUploadState(new Set([TEST_LISH_ID]), () => {});
		const { stream, sent } = fakeLISHStream([{ type: 'getLishs' }]);

		await handleLISHProtocol(stream as any, dataServer, 'peer-stranger', 'DIRECT', refuseAll, refuseAll);

		const [res] = await decodeLISHResponses(sent);
		expect(res.lishs).toEqual([]);
	});

	it('lists only advertisable LISHs to a peer the gate allows', async () => {
		const db = createTestDB();
		populateTestDB(db);
		const dataServer = new DataServer(db);
		initUploadState(new Set([TEST_LISH_ID]), () => {});
		const { stream, sent } = fakeLISHStream([{ type: 'getLishs' }]);

		await handleLISHProtocol(stream as any, dataServer, 'peer-member', 'DIRECT', allowAll, allowAll);

		const [res] = await decodeLISHResponses(sent);
		expect(res.lishs.map((l: { id: string }) => l.id)).toEqual([TEST_LISH_ID]);
	});

	it('withholds the listing while verification keeps the LISH busy', async () => {
		const db = createTestDB();
		populateTestDB(db);
		const dataServer = new DataServer(db);
		initUploadState(new Set([TEST_LISH_ID]), () => {});
		setBusy(TEST_LISH_ID, 'verifying');
		const { stream, sent } = fakeLISHStream([{ type: 'getLishs' }]);

		await handleLISHProtocol(stream as any, dataServer, 'peer-member', 'DIRECT', allowAll, allowAll);

		const [res] = await decodeLISHResponses(sent);
		expect(res.lishs).toEqual([]);
	});

	it('serves the manifest to a peer both gates allow', async () => {
		// The positive control for the two refusals below: without it they would pass on
		// any incidental reason to withhold the manifest rather than on the gate.
		const db = servableDB();
		const dataServer = new DataServer(db);
		initUploadState(new Set([TEST_LISH_ID]), () => {});
		const { stream, sent } = fakeLISHStream([{ type: 'getLish', lishID: TEST_LISH_ID }]);

		await handleLISHProtocol(stream as any, dataServer, 'peer-member', 'DIRECT', allowAll, allowAll);

		const [res] = await decodeLISHResponses(sent);
		expect(res.manifest?.id).toBe(TEST_LISH_ID);
	});

	it('refuses the manifest to a peer the strict gate blocks, even when the list gate allows', async () => {
		// getLish reads the STRICT gate, not the softer listing one — a peer inside the
		// listing grace must not be able to pull a manifest on the strength of it.
		const db = servableDB();
		const dataServer = new DataServer(db);
		initUploadState(new Set([TEST_LISH_ID]), () => {});
		const { stream, sent } = fakeLISHStream([{ type: 'getLish', lishID: TEST_LISH_ID }]);

		await handleLISHProtocol(stream as any, dataServer, 'peer-recent', 'DIRECT', refuseAll, allowAll);

		const [res] = await decodeLISHResponses(sent);
		expect(res.manifest).toBeUndefined();
		expect(res.error).toBe(ErrorCodes.PEER_LISH_NOT_SHARED);
	});

	it('refuses the manifest of a non-advertisable LISH to an allowed peer', async () => {
		const db = servableDB();
		const dataServer = new DataServer(db);
		initUploadState(new Set(), () => {}); // nothing upload-enabled
		const { stream, sent } = fakeLISHStream([{ type: 'getLish', lishID: TEST_LISH_ID }]);

		await handleLISHProtocol(stream as any, dataServer, 'peer-member', 'DIRECT', allowAll, allowAll);

		const [res] = await decodeLISHResponses(sent);
		expect(res.manifest).toBeUndefined();
		expect(res.error).toBe(ErrorCodes.PEER_LISH_NOT_SHARED);
	});

	it('marks queued verification as busy before broadcasting pending-verification', () => {
		const enqueueBlock = LISHS_API_TS.slice(LISHS_API_TS.indexOf('function enqueueVerification'), LISHS_API_TS.indexOf('function processVerificationQueue'));
		expect(enqueueBlock).toContain("setBusy(lishID, 'verifying')");
		expect(enqueueBlock.indexOf("setBusy(lishID, 'verifying')")).toBeLessThan(enqueueBlock.indexOf("broadcast('lishs:verify'"));
	});
});
