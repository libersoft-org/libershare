import { beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DataServer } from '../../../src/lish/data-server.ts';
import { initUploadState, resetUploadState } from '../../../src/protocol/lish-protocol.ts';
import { isSearchAdvertisableLish } from '../../../src/protocol/network.ts';
import { markChunkDownloaded } from '../../../src/db/lishs.ts';
import { clearBusy, setBusy } from '../../../src/api/busy.ts';
import { createTestDB, populateTestDB, TEST_CHUNK_IDS, TEST_LISH_ID } from '../helpers/fixtures.ts';

const LISHS_API_TS = readFileSync(join(__dirname, '../../../src/api/lishs.ts'), 'utf-8');
const LISH_PROTOCOL_TS = readFileSync(join(__dirname, '../../../src/protocol/lish-protocol.ts'), 'utf-8');

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

	it('uses the same advertisable guard for direct getLishs and getLish protocol requests', () => {
		expect(LISH_PROTOCOL_TS).toContain('filter(l => isUploadAdvertisable(l.id))');
		expect(LISH_PROTOCOL_TS).toContain('if (!isUploadAdvertisable(request.lishID))');
	});

	it('marks queued verification as busy before broadcasting pending-verification', () => {
		const enqueueBlock = LISHS_API_TS.slice(LISHS_API_TS.indexOf('function enqueueVerification'), LISHS_API_TS.indexOf('function processVerificationQueue'));
		expect(enqueueBlock).toContain("setBusy(lishID, 'verifying')");
		expect(enqueueBlock.indexOf("setBusy(lishID, 'verifying')")).toBeLessThan(enqueueBlock.indexOf("broadcast('lishs:verify'"));
	});
});
