/**
 * `finalDirectory` is node-local state: an absolute path on this machine that carries the
 * OS user name. It must never reach a file another person opens, exactly like `directory`
 * and the per-chunk possession list. The wire direction is covered in
 * tests/unit/protocol/lish-protocol.test.ts; this pins the file-export direction.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportLISHToFile } from '../../../src/lish/lish.ts';
import type { IStoredLISH } from '@shared';

const dirs: string[] = [];

afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A LISH mid-download: living in temp, with a move target on this machine. */
function downloadingLISH(): IStoredLISH {
	return {
		id: 'export-strip-test',
		created: new Date().toISOString(),
		chunkSize: 1024,
		checksumAlgo: 'sha256',
		name: 'Export strip test',
		files: [{ path: 'a.bin', size: 1024, checksums: ['deadbeef'] }],
		directory: 'C:\\Users\\somebody\\LiberShare\\temp\\Export strip test',
		finalDirectory: 'C:\\Users\\somebody\\LiberShare\\finished\\Export strip test',
		chunks: ['deadbeef'],
	} as IStoredLISH;
}

describe('exportLISHToFile', () => {
	it('writes neither local path nor chunk possession into the exported file', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'lish-export-'));
		dirs.push(dir);
		const out = join(dir, 'exported.lish');

		await exportLISHToFile(downloadingLISH(), out);

		const raw = await readFile(out, 'utf8');
		// Assert on the raw text too: a nested copy would still leak the user name.
		expect(raw).not.toContain('somebody');
		expect(raw).not.toContain('finalDirectory');
		const parsed = JSON.parse(raw);
		expect(parsed.directory).toBeUndefined();
		expect(parsed.finalDirectory).toBeUndefined();
		expect(parsed.chunks).toBeUndefined();
		// The manifest itself must survive intact.
		expect(parsed.id).toBe('export-strip-test');
		expect(parsed.files[0].path).toBe('a.bin');
	});
});
