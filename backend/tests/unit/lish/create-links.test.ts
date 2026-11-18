import { describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { datasetCopyBytes } from '../../../src/lish/dataset-transfer.ts';
import { createLISH } from '../../../src/lish/lish.ts';

const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir';

/** A file symlink on Windows needs Developer Mode or an elevated process; without it the case cannot be built. */
async function fileSymlink(target: string, path: string): Promise<boolean> {
	try {
		await symlink(target, path, 'file');
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EPERM' && process.platform === 'win32') return false;
		throw error;
	}
}

describe('createLISH symlinks', () => {
	it('stores a file link target relative to the shared folder and leaves out folder links and links pointing outside it', async () => {
		const base = await mkdtemp(join(tmpdir(), 'create-links-'));
		try {
			const shared = join(base, 'shared');
			const outside = join(base, 'outside');
			await mkdir(join(shared, 'sub'), { recursive: true });
			await mkdir(outside);
			await writeFile(join(shared, 'sub', 'a.bin'), 'data');
			await writeFile(join(outside, 'secret.bin'), 'private');
			// A receiver recreates links to files of the manifest only, so a folder link must not be published.
			await symlink(join(shared, 'sub'), join(shared, 'folder-link'), dirLinkType);
			await symlink(outside, join(shared, 'away'), dirLinkType);
			const withFileLinks = (await fileSymlink(join(shared, 'sub', 'a.bin'), join(shared, 'inside.bin'))) && (await fileSymlink(join(outside, 'secret.bin'), join(shared, 'away.bin')));

			const lish = await createLISH(shared, 'links', 1024, 'sha256');

			expect(lish.links ?? []).toEqual(withFileLinks ? [expect.objectContaining({ path: 'inside.bin', target: 'sub/a.bin' })] : []);
			expect(JSON.stringify(lish.links ?? [])).not.toContain(base.replaceAll('\\', '/'));
			// The receiver's own rule: every link must resolve to a file of the manifest.
			expect(() => datasetCopyBytes(lish, { kind: 'explicit', path: shared })).not.toThrow();
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it('skips a dangling directory link and keeps sharing the existing files', async () => {
		const base = await mkdtemp(join(tmpdir(), 'create-links-'));
		try {
			await writeFile(join(base, 'keep.bin'), 'data');
			await symlink(join(base, 'missing'), join(base, 'dangling'), dirLinkType);

			const lish = await createLISH(base, 'links', 1024, 'sha256');

			expect(lish.files?.map(file => file.path)).toEqual(['keep.bin']);
			expect(lish.links).toBeUndefined();
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it('omits a link whose target appeared after its directory was scanned', async () => {
		const base = await mkdtemp(join(tmpdir(), 'create-links-'));
		try {
			const sub = join(base, 'sub');
			const lateTarget = join(sub, 'late.bin');
			await mkdir(sub);
			await writeFile(join(sub, 'keep.bin'), 'data');
			if (!(await fileSymlink(lateTarget, join(base, 'z-link.bin')))) return;

			const lish = await createLISH(base, 'links', 1024, 'sha256', 1, undefined, info => {
				if (info.type === 'file' && info.path === 'sub/keep.bin') writeFileSync(lateTarget, 'late');
			});

			expect(lish.files?.map(file => file.path)).toEqual(['sub/keep.bin']);
			expect(lish.links).toBeUndefined();
			expect(() => datasetCopyBytes(lish, { kind: 'explicit', path: base })).not.toThrow();
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it('points a link to a hardlinked copy at the file the manifest lists', async () => {
		const base = await mkdtemp(join(tmpdir(), 'create-links-'));
		try {
			await mkdir(join(base, 'sub'));
			await writeFile(join(base, 'a.bin'), 'data');
			await link(join(base, 'a.bin'), join(base, 'b.bin'));
			if (!(await fileSymlink(join(base, 'b.bin'), join(base, 'sub', 'to-copy.bin')))) return;

			const lish = await createLISH(base, 'links', 1024, 'sha256');

			const target = lish.links?.find(entry => entry.path === 'sub/to-copy.bin')?.target;
			expect(lish.files?.map(file => file.path)).toContain(target);
			expect(() => datasetCopyBytes(lish, { kind: 'explicit', path: base })).not.toThrow();
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});
