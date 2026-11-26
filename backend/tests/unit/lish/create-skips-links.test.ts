import { describe, expect, it, afterAll } from 'bun:test';
import { existsSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLISH } from '../../../src/lish/lish.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import { itWithFileSymlinks } from '../../helpers/file-symlink.ts';

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function dataset(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'lish-skip-links-'));
	dirs.push(dir);
	mkdirSync(join(dir, 'sub'));
	writeFileSync(join(dir, 'a.bin'), 'first file');
	writeFileSync(join(dir, 'sub', 'inner.bin'), 'inner file');
	return dir;
}

describe('createLISH lists no links', () => {
	itWithFileSymlinks('skips a symbolic link to a file', async () => {
		const dir = await dataset();
		symlinkSync(join(dir, 'a.bin'), join(dir, 'link.bin'), 'file');
		const lish = await createLISH(dir, 'links', 1024, 'sha256');
		expect((lish.files ?? []).map(file => file.path)).toEqual(['a.bin', 'sub/inner.bin']);
		expect(lish).not.toHaveProperty('links');
	});

	it('skips a link to a folder and does not walk into it', async () => {
		const dir = await dataset();
		// A junction needs no privilege on Windows; elsewhere it is an ordinary directory symlink.
		symlinkSync(join(dir, 'sub'), join(dir, 'sub-link'), process.platform === 'win32' ? 'junction' : 'dir');
		const lish = await createLISH(dir, 'links', 1024, 'sha256');
		expect((lish.files ?? []).map(file => file.path)).toEqual(['a.bin', 'sub/inner.bin']);
		expect((lish.directories ?? []).map(directory => directory.path)).toEqual(['sub']);
		expect(lish).not.toHaveProperty('links');
	});

	itWithFileSymlinks('skips a symbolic link that leads nowhere instead of failing', async () => {
		const dir = await dataset();
		symlinkSync(join(dir, 'missing.bin'), join(dir, 'broken.bin'), 'file');
		const lish = await createLISH(dir, 'links', 1024, 'sha256');
		expect((lish.files ?? []).map(file => file.path)).toEqual(['a.bin', 'sub/inner.bin']);
	});

	itWithFileSymlinks('refuses a symbolic link to a file picked on its own, before anything is exported', async () => {
		const dir = await dataset();
		const link = join(dir, 'link.bin');
		symlinkSync(join(dir, 'a.bin'), link, 'file');
		await expect(createLISH(link, 'link', 1024, 'sha256')).rejects.toMatchObject({ code: 'INVALID_INPUT_TYPE' });
		const handlers = initLISHsHandlers(
			{} as never,
			() => {},
			() => {},
			{ get: () => undefined } as never
		);
		const exported = join(dir, 'out.lish');
		await expect(handlers.create({ dataPath: link, lishFile: exported }, null)).rejects.toMatchObject({ code: 'INVALID_INPUT_TYPE' });
		expect(existsSync(exported)).toBe(false);
	});

	it('lists a hard-linked file once, under its first name', async () => {
		const dir = await dataset();
		linkSync(join(dir, 'a.bin'), join(dir, 'b.bin'));
		linkSync(join(dir, 'a.bin'), join(dir, 'sub', 'c.bin'));
		const lish = await createLISH(dir, 'links', 1024, 'sha256');
		expect((lish.files ?? []).map(file => file.path)).toEqual(['a.bin', 'sub/inner.bin']);
		expect(lish).not.toHaveProperty('links');
	});
});
