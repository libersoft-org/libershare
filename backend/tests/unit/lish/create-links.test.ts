import { describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLISH } from '../../../src/lish/lish.ts';

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

describe('createLISH symlinks', () => {
	it('stores a link target relative to the shared folder and leaves out a link pointing outside it', async () => {
		const base = await mkdtemp(join(tmpdir(), 'create-links-'));
		try {
			const shared = join(base, 'shared');
			const outside = join(base, 'outside');
			await mkdir(join(shared, 'sub'), { recursive: true });
			await mkdir(outside);
			await writeFile(join(shared, 'sub', 'a.bin'), 'data');
			await writeFile(join(outside, 'secret.bin'), 'private');
			await symlink(join(shared, 'sub'), join(shared, 'inside'), linkType);
			await symlink(outside, join(shared, 'away'), linkType);

			const lish = await createLISH(shared, 'links', 1024, 'sha256');

			expect(lish.links).toEqual([expect.objectContaining({ path: 'inside', target: 'sub' })]);
			expect(JSON.stringify(lish.links)).not.toContain(base.replaceAll('\\', '/'));
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});
