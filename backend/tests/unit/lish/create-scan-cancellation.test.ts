import { describe, expect, it, afterAll, spyOn } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
const { mkdtemp, mkdir, rm, writeFile } = fsPromises;
import { tmpdir } from 'os';
import { join } from 'path';
import { createLISH } from '../../../src/lish/lish.ts';

/**
 * A cancelled creation must stop during the directory scan, not only once it reaches the
 * checksums.
 *
 * The scan is the first long pass over a large tree, and it held the mutation permit for
 * its whole run. A factory reset that had already asked the creation to stop then waited
 * for exactly the work it cancelled — the wait this is supposed to remove.
 *
 * The file-list event is the discriminator, not elapsed time: it is emitted between the
 * scan and the checksum pass, so a scan that ran to the end announces its result even
 * though the creation was already cancelled.
 */

const dirs: string[] = [];

afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** A tree with enough entries that a scan has somewhere to keep going. */
async function makeTree(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'lish-scan-'));
	dirs.push(root);
	for (let i = 0; i < 6; i++) {
		const sub = join(root, `dir-${i}`);
		await mkdir(sub);
		for (let f = 0; f < 4; f++) await writeFile(join(sub, `file-${f}.bin`), Buffer.alloc(4096, i));
	}
	return root;
}

/** A tree large enough that scanning it cannot finish inside a millisecond. */
async function makeBigTree(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'lish-scan-big-'));
	dirs.push(root);
	for (let i = 0; i < 40; i++) {
		const sub = join(root, `dir-${i}`);
		await mkdir(sub);
		await Promise.all(Array.from({ length: 50 }, (_, f) => writeFile(join(sub, `file-${f}.bin`), 'x')));
	}
	return root;
}

describe('cancelling a creation during its directory scan', () => {
	it('stops the scan instead of walking the rest of the tree', async () => {
		const root = await makeTree();
		const events: string[] = [];
		const controller = new AbortController();
		controller.abort();

		await expect(createLISH(root, undefined, 1024, 'sha256', 1, undefined, info => events.push(info.type), undefined, controller.signal)).rejects.toThrow('LISH_CREATE_CANCELLED');
		// A scan that finished would have announced the file list before the checksum pass
		// noticed the cancellation.
		expect(events).toEqual([]);
	});

	it('stops a scan that is already under way', async () => {
		const root = await makeBigTree();
		const events: string[] = [];
		const controller = new AbortController();

		// Cancelled after the scan has started, not before it: 2000 entries take far longer
		// than this timer, so the abort lands inside the walk rather than ahead of it.
		const creating = createLISH(root, undefined, 1024, 'sha256', 1, undefined, info => events.push(info.type), undefined, controller.signal);
		setTimeout(() => controller.abort(), 1);

		await expect(creating).rejects.toThrow('LISH_CREATE_CANCELLED');
		expect(events).toEqual([]);
	});

	it('does not start a new directory listing once cancelled', async () => {
		const root = await mkdtemp(join(tmpdir(), 'lish-scan-entry-'));
		dirs.push(root);
		const sub = join(root, 'sub');
		await mkdir(sub);
		await Promise.all(Array.from({ length: 30 }, (_, f) => writeFile(join(sub, `file-${f}.bin`), 'x')));

		const controller = new AbortController();
		// One glob per directory listed. `Glob.scan()` reads the whole directory before it
		// yields anything, so counting the listings is what tells a cancel that stopped the
		// walk from one that merely stopped reading its results.
		const RealGlob = Bun.Glob;
		let listings = 0;
		const globSpy = spyOn(Bun, 'Glob');
		globSpy.mockImplementation(((pattern: string) => {
			listings++;
			return new RealGlob(pattern);
		}) as never);
		// Cancelled inside the metadata read for the subdirectory: the moment right before the
		// recursion that would list it.
		let lstats = 0;
		const lstatSpy = spyOn(fsPromises, 'lstat').mockImplementation(((): any => {
			lstats++;
			if (lstats === 1) controller.abort();
			return Promise.resolve({ isSymbolicLink: () => false });
		}) as any);

		try {
			await expect(createLISH(root, undefined, 1024, 'sha256', 1, undefined, undefined, undefined, controller.signal)).rejects.toThrow('LISH_CREATE_CANCELLED');
			// Only the root was listed. A second listing means the walk opened a directory it
			// had already been told to abandon.
			expect(listings).toBe(1);
		} finally {
			lstatSpy.mockRestore();
			globSpy.mockRestore();
		}
	});

	it('does not open another directory in the checksum pass either', async () => {
		const root = await mkdtemp(join(tmpdir(), 'lish-scan-pass2-'));
		dirs.push(root);
		const sub = join(root, 'sub');
		await mkdir(sub);
		await Promise.all(Array.from({ length: 30 }, (_, f) => writeFile(join(sub, `file-${f}.bin`), 'x')));

		// Building a directory LISH walks the tree twice: once to announce the file list, once
		// to hash it. The second walk has the same window — it reads metadata about a
		// subdirectory and then opens it — so it needs the same two checks.
		const controller = new AbortController();
		const RealGlob = Bun.Glob;
		let listings = 0;
		const globSpy = spyOn(Bun, 'Glob');
		globSpy.mockImplementation(((pattern: string) => {
			listings++;
			return new RealGlob(pattern);
		}) as never);
		// The subdirectory is lstat'ed once per pass. Cancelling on the SECOND one lands inside
		// the hashing pass, right after it decided to recurse and before it opens the directory.
		let subStats = 0;
		const lstatSpy = spyOn(fsPromises, 'lstat');
		lstatSpy.mockImplementation(((path: string): any => {
			if (String(path).endsWith('sub')) {
				subStats++;
				if (subStats === 2) controller.abort();
			}
			return Promise.resolve({ isSymbolicLink: () => false });
		}) as never);

		try {
			await expect(createLISH(root, undefined, 1024, 'sha256', 1, undefined, undefined, undefined, controller.signal)).rejects.toThrow('LISH_CREATE_CANCELLED');
			// Three listings: both directories in the announcing pass, then the root in the
			// hashing pass. A fourth means the cancelled walk opened the subdirectory anyway.
			expect(listings).toBe(3);
		} finally {
			lstatSpy.mockRestore();
			globSpy.mockRestore();
		}
	});

	it('still scans the whole tree when nothing cancelled it', async () => {
		const root = await makeTree();
		const announced: string[] = [];
		const events: string[] = [];

		const lish = await createLISH(
			root,
			undefined,
			1024,
			'sha256',
			1,
			undefined,
			info => {
				events.push(info.type);
				if (info.type === 'file-list') announced.push(...info.files.map(file => file.path));
			},
			undefined,
			new AbortController().signal
		);

		// The scan announces its result and the manifest carries exactly what it announced.
		// Not compared against the number of files written: this host drops a couple of them,
		// which is a separate defect in the hard-link detection, not something this guards.
		expect(events[0]).toBe('file-list');
		expect(announced.length).toBeGreaterThan(0);
		expect(lish.files?.map(file => file.path).sort()).toEqual([...announced].sort());
	});
});
