import { afterEach, describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { getDatasetRoot, setDatasetRoot, relocateDataset, addDataset } from '../../../src/db/lishs-roots.ts';
import { getDatasetLinkBindings } from '../../../src/db/lishs-link-bindings.ts';
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


it('stores link associations atomically with relocation and resets them on import', () => {
 const db = fixture();
 const before = {kind: 'explicit' as const, path: resolve('before')};
 const after = {kind: 'explicit' as const, path: resolve('after')};
 const binding = {path: 'copy.bin', target: resolve('original/data.bin'), source: 'data.bin', hardlink: false};
 addDataset(db, {...createTestLISH(TEST_LISH_ID), directory: before.path}, before);
 relocateDataset(db, TEST_LISH_ID, after, false, [binding]);
 expect(getDatasetLinkBindings(db, TEST_LISH_ID)).toEqual([binding]);
 expect(getLISH(db, TEST_LISH_ID)).not.toHaveProperty('linkBindings');
 db.run("CREATE TRIGGER refuse_binding BEFORE INSERT ON lishs_link_bindings BEGIN SELECT RAISE(ABORT, 'binding write rejected'); END");
 expect(() => relocateDataset(db, TEST_LISH_ID, before, true, [{...binding, source: 'another.bin'}])).toThrow('binding write rejected');
 expect(getDatasetRoot(db, TEST_LISH_ID)).toEqual(after);
 expect(getLISH(db, TEST_LISH_ID)?.directory).toBe(after.path);
 expect(getDatasetLinkBindings(db, TEST_LISH_ID)).toEqual([binding]);
 addDataset(db, {...createTestLISH(TEST_LISH_ID), directory: before.path}, before);
 expect(getDatasetLinkBindings(db, TEST_LISH_ID)).toEqual([]);
});

it('keeps local link associations when an overwrite rolls back', () => {
 const db = fixture();
 const root = {kind: 'explicit' as const, path: resolve('before')};
 const binding = {path: 'copy.bin', target: resolve('original/data.bin'), source: 'data.bin', hardlink: false};
 relocateDataset(db, TEST_LISH_ID, root, false, [binding]);
 db.run("CREATE TRIGGER refuse_root BEFORE UPDATE ON lishs_roots BEGIN SELECT RAISE(ABORT, 'root rejected'); END");
 expect(() => addDataset(db, {...createTestLISH(TEST_LISH_ID), files: []}, root)).toThrow('root rejected');
 expect(getDatasetLinkBindings(db, TEST_LISH_ID)).toEqual([binding]);
 deleteLISH(db, TEST_LISH_ID);
 expect(getDatasetLinkBindings(db, TEST_LISH_ID)).toEqual([]);
});
