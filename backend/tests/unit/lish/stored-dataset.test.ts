import { afterEach, expect, it } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataServer } from '../../../src/lish/data-server.ts';
import { storedDatasetFilesPresent } from '../../../src/lish/stored-dataset.ts';
import { createTestDB, createTestLISH, TEST_LISH_ID } from '../helpers/fixtures.ts';

const directories: string[] = [];
const databases: ReturnType<typeof createTestDB>[] = [];
afterEach(async () => {
	for (const db of databases.splice(0)) db.close();
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
	const base = await mkdtemp(join(tmpdir(), 'stored-dataset-'));
	directories.push(base);
	const directory = join(base, 'dataset');
	await mkdir(directory);
	const db = createTestDB();
	databases.push(db);
	const server = new DataServer(db);
	const lish = createTestLISH({ id: TEST_LISH_ID, directory, files: [{ path: 'file.txt', size: 4, checksums: ['a'.repeat(64)] }] });
	server.add(lish);
	server.setDatasetRoot(lish.id, { kind: 'derived', base, component: 'dataset' });
	return { base, directory, server, lish };
}

it('checks complete data on disk and reports missing or short files', async () => {
	const { directory, server, lish } = await fixture();
	expect(await storedDatasetFilesPresent(server, lish)).toBe(false);
	await writeFile(join(directory, 'file.txt'), 'data');
	expect(await storedDatasetFilesPresent(server, lish)).toBe(true);
	await writeFile(join(directory, 'file.txt'), 'x');
	expect(await storedDatasetFilesPresent(server, lish)).toBe(false);
});

it('refuses a substituted dataset root even when the outside file has the right size', async () => {
	const { base, directory, server, lish } = await fixture();
	const outside = join(base, 'outside');
	await mkdir(outside);
	await writeFile(join(outside, 'file.txt'), 'keep');
	await rm(directory, { recursive: true });
	await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
	await expect(storedDatasetFilesPresent(server, lish)).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
	expect(await readFile(join(outside, 'file.txt'), 'utf8')).toBe('keep');
});
