import { describe, expect, it, afterAll, spyOn } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLISH } from '../../../src/lish/lish.ts';

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/**
 * NTFS file IDs above 2^53 cannot be told apart once converted to a JS number: 2^53 and
 * 2^53 + 1 are the same number. A real filesystem cannot be made to hand out such IDs on
 * demand, so the stat call is wrapped to report two adjacent ones for two real files.
 */
describe('createLISH keeps files whose inode numbers differ only above 2^53', () => {
	it('records both files with their own content, none as a hard link', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'lish-ino-'));
		dirs.push(dir);
		await writeFile(join(dir, 'a.bin'), 'first file');
		await writeFile(join(dir, 'b.bin'), 'second file!');
		const huge = 2n ** 53n;
		const realStat = fsPromises.stat;
		const spy = spyOn(fsPromises, 'stat').mockImplementation((async (path: any, opts?: any) => {
			const real: any = await (realStat as any)(path, opts);
			if (!opts?.bigint || !real.isFile()) return real;
			const ino = String(path).endsWith('a.bin') ? huge : huge + 1n;
			return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { ino, dev: 7n });
		}) as any);
		// The same two IDs as they arrive through a number-based stat: identical after rounding.
		const realFile = Bun.file;
		const fileSpy = spyOn(Bun, 'file').mockImplementation(((path: any, opts?: any) => {
			const file: any = realFile(path, opts);
			const realFileStat = file.stat.bind(file);
			file.stat = async () => {
				const s: any = await realFileStat();
				if (!s.isFile()) return s;
				const ino = Number(String(path).endsWith('a.bin') ? huge : huge + 1n);
				return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino, dev: 7 });
			};
			return file;
		}) as any);
		try {
			const lish = await createLISH(dir, 'ino', 1024, 'sha256');
			expect((lish.files ?? []).map(f => f.path).sort()).toEqual(['a.bin', 'b.bin']);
			expect(lish.links ?? []).toEqual([]);
			for (const f of lish.files ?? []) expect(f.checksums.length).toBe(1);
		} finally {
			spy.mockRestore();
			fileSpy.mockRestore();
		}
	});
});

describe('createLISH refuses a size a JS number cannot hold exactly', () => {
	it('fails before hashing instead of recording a rounded size', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'lish-size-'));
		dirs.push(dir);
		await writeFile(join(dir, 'big.bin'), 'x');
		const realStat = fsPromises.stat;
		const spy = spyOn(fsPromises, 'stat').mockImplementation((async (path: any, opts?: any) => {
			const real: any = await (realStat as any)(path, opts);
			if (!opts?.bigint || !real.isFile()) return real;
			return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { size: 2n ** 53n + 2n });
		}) as any);
		try {
			await expect(createLISH(join(dir, 'big.bin'), 'big', 1024, 'sha256')).rejects.toThrow('is not supported');
		} finally {
			spy.mockRestore();
		}
	});
});
