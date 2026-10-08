import { describe, expect, it } from 'bun:test';
import { getLISH, getLISHDetail, listAllStoredLISHs, listLISHSummaries } from '../../../src/db/lishs.ts';
import { TEST_LISH_ID, createTestDB, populateTestDB } from '../helpers/fixtures.ts';

const PUBLISHER = '12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf';
const SIGNATURE = 'S'.repeat(86);

describe('stored publisher and signature', () => {
	it('come back in the full body and as publisher in the API views', () => {
		const db = createTestDB();
		populateTestDB(db);
		db.run('UPDATE lishs SET publisher = ?, signature = ? WHERE lish_id = ?', [PUBLISHER, SIGNATURE, TEST_LISH_ID]);
		const body = getLISH(db, TEST_LISH_ID)!;
		expect(body.publisher).toBe(PUBLISHER);
		expect(body.signature).toBe(SIGNATURE);
		expect(listAllStoredLISHs(db).find(item => item.id === TEST_LISH_ID)?.signature).toBe(SIGNATURE);
		expect(listLISHSummaries(db).find(item => item.id === TEST_LISH_ID)?.publisher).toBe(PUBLISHER);
		expect(getLISHDetail(db, TEST_LISH_ID)?.publisher).toBe(PUBLISHER);
	});

	it('are absent for an unsigned item', () => {
		const db = createTestDB();
		populateTestDB(db);
		const body = getLISH(db, TEST_LISH_ID)!;
		expect('publisher' in body).toBe(false);
		expect('signature' in body).toBe(false);
		expect(getLISHDetail(db, TEST_LISH_ID)?.publisher).toBeUndefined();
	});
});
