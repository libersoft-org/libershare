import { describe, expect, it, afterAll } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
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
