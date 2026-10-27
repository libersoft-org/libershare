import { describe, it, expect } from 'bun:test';
import { summarizeManifest } from '../../../src/lish/lish.ts';
import type { ILISH } from '@shared';

function manifest(): ILISH {
	return {
		id: 'a0000000-0000-4000-8000-000000000001',
		name: 'Summary test',
		description: 'Two files and a link',
		created: '2026-01-01T00:00:00.000Z',
		chunkSize: 1024,
		checksumAlgo: 'sha256',
		files: [
			{ path: 'dir/a.bin', size: 2560, checksums: ['aa', 'bb', 'cc'], modified: '2026-01-01T00:00:00.000Z' },
			{ path: 'empty.txt', size: 0, checksums: [] },
		],
		directories: [{ path: 'dir' }],
		links: [{ path: 'dir/link', target: 'a.bin' }],
	};
}

describe('summarizeManifest', () => {
	it('counts chunks and totals without passing the checksums on', () => {
		const detail = summarizeManifest(manifest());
		expect(detail.totalChunks).toBe(3);
		expect(detail.totalSize).toBe(2560);
		expect(detail.fileCount).toBe(2);
		expect(detail.directoryCount).toBe(1);
		expect(detail.links).toEqual([{ path: 'dir/link', target: 'a.bin' }]);
		expect(detail.files).toEqual([
			{ path: 'dir/a.bin', size: 2560, modified: '2026-01-01T00:00:00.000Z' },
			{ path: 'empty.txt', size: 0 },
		]);
		expect(JSON.stringify(detail)).not.toContain('checksums');
	});

	it('passes on only metadata of the right kind and names the rest', () => {
		// Written by anyone: the structure check leaves these fields alone, the display must not trust them.
		const bad = { toString: 0, valueOf: 0 } as unknown as string;
		const detail = summarizeManifest({
			...manifest(),
			files: [{ path: 'a.bin', size: 10, checksums: ['aa'], created: bad, modified: 'not a date', permissions: '0640' }],
			directories: [{ path: 'dir', permissions: 755 as unknown as string, created: '2020-01-02T03:04:05.000Z', extra: 'dropped' } as never],
			links: [{ path: 'dir/link', target: 'a.bin', hardlink: 'yes' as unknown as boolean, modified: null as unknown as string }],
		});
		expect(detail.files).toEqual([{ path: 'a.bin', size: 10, permissions: '0640', invalidFields: ['modified', 'created'] }]);
		expect(detail.directories).toEqual([{ path: 'dir', created: '2020-01-02T03:04:05.000Z', invalidFields: ['permissions'] }]);
		expect(detail.links).toEqual([{ path: 'dir/link', target: 'a.bin', invalidFields: ['hardlink', 'modified'] }]);
	});

	it('summarizes a manifest without files as empty', () => {
		const { files: _files, directories: _directories, links: _links, ...bare } = manifest();
		const detail = summarizeManifest(bare);
		expect(detail).toMatchObject({ totalChunks: 0, totalSize: 0, fileCount: 0, directoryCount: 0, files: [], directories: [], links: [] });
	});
});
