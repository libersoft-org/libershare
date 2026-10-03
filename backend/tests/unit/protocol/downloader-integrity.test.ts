import { describe, it, expect, afterEach } from 'bun:test';
import { FileAllocator } from '../../../src/protocol/file-allocator.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestLISH, TEST_LISH_ID } from '../helpers/fixtures.ts';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function manifest(path: string) {
	return createTestLISH({ id: TEST_LISH_ID, files: [{ path, size: 4, checksums: ['a'.repeat(64)] }] });
}

describe('download allocation paths', () => {
	it.each(['movie.mkv', 'video/movie.mkv', 'a/b/c/d/e/file.txt', 'my folder/my file.txt', 'složka/soubor-čěšřž.txt'])('allocates an ordinary manifest path: %s', async path => {
		const base = await mkdtemp(join(tmpdir(), 'download-path-'));
		roots.push(base);
		const allocator = new FileAllocator({ kind: 'derived', base, component: 'dataset' });
		await allocator.allocateStructure(manifest(path));
		expect(await readFile(join(base, 'dataset', path))).toEqual(Buffer.alloc(4));
	});

	it.each(['../outside', '../../outside', 'subdir/../../outside', 'a/b/c/../../../../outside', '..\\\\outside', '..\\\\leaf/../../outside', 'subdir/../outside', 'a/b/../b/file.txt', '/etc/passwd', '..', '/../outside', './file.txt', 'C:/outside', 'a//b'])('rejects a noncanonical path before changing data: %s', async path => {
		const base = await mkdtemp(join(tmpdir(), 'download-path-'));
		roots.push(base);
		await writeFile(join(base, 'outside'), 'keep');
		const allocator = new FileAllocator({ kind: 'derived', base, component: 'dataset' });
		await expect(allocator.allocateStructure(manifest(path))).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
		expect(await readFile(join(base, 'outside'), 'utf8')).toBe('keep');
	});
});
