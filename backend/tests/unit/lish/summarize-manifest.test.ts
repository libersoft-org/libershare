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

	it('summarizes a manifest without files as empty', () => {
		const { files: _files, directories: _directories, links: _links, ...bare } = manifest();
		const detail = summarizeManifest(bare);
		expect(detail).toMatchObject({ totalChunks: 0, totalSize: 0, fileCount: 0, directoryCount: 0, files: [], directories: [], links: [] });
	});
});
