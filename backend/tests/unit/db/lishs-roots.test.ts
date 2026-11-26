import { afterEach, describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { getDatasetRoot, setDatasetRoot, relocateDataset, addDataset } from '../../../src/db/lishs-roots.ts';
import { addLISH, deleteLISH, getLISH } from '../../../src/db/lishs.ts';
import { createTestDB, createTestLISH, TEST_LISH_ID } from '../helpers/fixtures.ts';

const databases: ReturnType<typeof createTestDB>[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture() {
	const db = createTestDB();
	databases.push(db);
	addLISH(db, createTestLISH(TEST_LISH_ID));
	return db;
}

describe('local dataset roots', () => {
	it('preserves root choices across manifest updates without exporting them', () => {
		const db = fixture();
		const root = { kind: 'derived' as const, base: resolve('downloads'), component: 'dataset' };
		const final = { kind: 'explicit' as const, path: resolve('finished') };
		setDatasetRoot(db, TEST_LISH_ID, root);
		setDatasetRoot(db, TEST_LISH_ID, final, true);
		addLISH(db, { ...createTestLISH(TEST_LISH_ID), name: 'Updated', datasetRoot: { kind: 'explicit', path: resolve('untrusted') } } as any);
		expect(getDatasetRoot(db, TEST_LISH_ID)).toEqual(root);
		expect(getDatasetRoot(db, TEST_LISH_ID, true)).toEqual(final);
		expect(getLISH(db, TEST_LISH_ID)).not.toHaveProperty('datasetRoot');
		setDatasetRoot(db, TEST_LISH_ID, null, true);
		expect(getDatasetRoot(db, TEST_LISH_ID, true)).toBeNull();
		expect(getDatasetRoot(db, TEST_LISH_ID)).toEqual(root);
		deleteLISH(db, TEST_LISH_ID);
		expect(getDatasetRoot(db, TEST_LISH_ID)).toBeNull();
	});

	it('rejects unsafe local roots and corrupt persisted choices', () => {
		const db = fixture();
		for (const component of ['..', 'a/b', 'a\\b', 'a:b', '']) {
			expect(() => setDatasetRoot(db, TEST_LISH_ID, { kind: 'derived', base: resolve('downloads'), component })).toThrow('Invalid local dataset root');
		}
		db.run('INSERT INTO lishs_roots VALUES (?, 0, ?)', [TEST_LISH_ID, '{invalid']);
		expect(() => getDatasetRoot(db, TEST_LISH_ID)).toThrow('Invalid stored dataset root');
	});

	it('rolls back both the directory and the root when storing the root fails', () => {
		const db = fixture();
		const root = { kind: 'explicit' as const, path: resolve('before') };
		addDataset(db, { ...createTestLISH(TEST_LISH_ID), directory: root.path }, root);
		db.run("CREATE TRIGGER refuse_root BEFORE UPDATE ON lishs_roots BEGIN SELECT RAISE(ABORT, 'root write rejected'); END");
		expect(() => relocateDataset(db, TEST_LISH_ID, { kind: 'explicit', path: resolve('after') })).toThrow('root write rejected');
		expect(getLISH(db, TEST_LISH_ID)?.directory).toBe(root.path);
		expect(getDatasetRoot(db, TEST_LISH_ID)).toEqual(root);
		expect(() => addDataset(db, { ...createTestLISH(TEST_LISH_ID), directory: resolve('after'), files: [] }, root)).toThrow('root write rejected');
		expect(getLISH(db, TEST_LISH_ID)?.files).toHaveLength(2);
		expect(getLISH(db, TEST_LISH_ID)?.directory).toBe(root.path);
	});
});
