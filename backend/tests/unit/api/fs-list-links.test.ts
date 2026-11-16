import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync } from 'fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FsEntry } from '@shared';
import { initFsHandlers } from '../../../src/api/fs.ts';

const isWindows = process.platform === 'win32';
// Junctions need no privileges on Windows; elsewhere the type argument is ignored.
const dirLinkType = isWindows ? 'junction' : 'dir';

// Built at load time so `it.skipIf` can see whether file symlinks are allowed here.
const root = await mkdtemp(join(tmpdir(), 'lish-fs-links-'));
await mkdir(join(root, 'real-dir'));
await writeFile(join(root, 'real-file.txt'), 'hello');
await symlink(join(root, 'real-dir'), join(root, 'dir-link'), dirLinkType);
await symlink(join(root, 'missing'), join(root, 'broken-link'), dirLinkType);
let fileLinkDenied = false;
try {
	await symlink(join(root, 'real-file.txt'), join(root, 'file-link.txt'), 'file');
} catch (err: any) {
	// Windows without Developer Mode or admin rights refuses file symlinks.
	if (isWindows && err?.code === 'EPERM') fileLinkDenied = true;
	else throw err;
}
if (fileLinkDenied) console.warn('fs-list-links: file symlink test skipped, EPERM (needs Developer Mode or admin on Windows)');

describe('fs.list and fs.delete with links', () => {
	let entries: Map<string, FsEntry>;

	beforeAll(async () => {
		const result = await initFsHandlers().list({ path: root });
		entries = new Map(result.entries.map(e => [e.name, e]));
	});

	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('reports plain entries without a link flag', () => {
		expect(entries.get('real-dir')).toMatchObject({ type: 'directory' });
		expect(entries.get('real-dir')?.link).toBeUndefined();
		expect(entries.get('real-file.txt')).toMatchObject({ type: 'file', size: 5 });
		expect(entries.get('real-file.txt')?.link).toBeUndefined();
	});

	it('reports a linked directory as a directory keeping the link path', () => {
		const entry = entries.get('dir-link');
		expect(entry).toMatchObject({ type: 'directory', link: true, path: join(root, 'dir-link') });
		expect(entry?.broken).toBeUndefined();
	});

	it('lists a linked directory through the link path', async () => {
		const result = await initFsHandlers().list({ path: join(root, 'dir-link') });
		expect(result.path).toBe(join(root, 'dir-link'));
		expect(result.entries).toEqual([]);
	});

	it('reports a broken link as an unopenable file and keeps listing', () => {
		expect(entries.get('broken-link')).toMatchObject({ type: 'file', link: true, broken: true });
		expect(entries.size).toBe(fileLinkDenied ? 4 : 5);
	});

	it('sorts linked directories with the other directories', () => {
		const names = [...entries.values()].map(e => e.name);
		expect(names.slice(0, 2)).toEqual(['dir-link', 'real-dir']);
	});

	it.skipIf(fileLinkDenied)('reports a linked file as a file', () => {
		expect(entries.get('file-link.txt')).toMatchObject({ type: 'file', link: true, size: 5 });
		expect(entries.get('file-link.txt')?.broken).toBeUndefined();
	});

	// A linked folder now opens like any other, so "Delete directory" can be run on the link path itself.
	it('deleting a linked directory removes only the link and keeps the target files', async () => {
		const target = join(root, 'delete-target');
		const link = join(root, 'delete-link');
		await mkdir(join(target, 'sub'), { recursive: true });
		await writeFile(join(target, 'sub', 'keep.txt'), 'keep');
		await symlink(target, link, dirLinkType);
		await initFsHandlers().delete({ path: link });
		expect(existsSync(link)).toBe(false);
		expect(await readFile(join(target, 'sub', 'keep.txt'), 'utf8')).toBe('keep');
	});
});
