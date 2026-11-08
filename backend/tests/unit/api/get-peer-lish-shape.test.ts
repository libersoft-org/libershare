import { describe, expect, it } from 'bun:test';
import { encode as lpEncode } from 'it-length-prefixed';
import { encode as codecEncode } from '../../../src/protocol/codec.ts';
import { initLISHnetsHandlers } from '../../../src/api/lishnets.ts';
import type { IStoredLISH } from '@shared';

/**
 * The peer LISH detail now comes from the summary the local .lish preview uses. For a manifest
 * with well-formed metadata it must answer exactly what it answered before, plus `totalChunks`.
 */

const MANIFEST = {
	id: 'lish-peer-shape-test',
	name: 'Shape',
	description: 'From a peer',
	created: '2026-01-01T00:00:00.000Z',
	chunkSize: 1024,
	checksumAlgo: 'sha256',
	files: [
		{ path: 'dir/a.bin', size: 2500, checksums: ['h1', 'h2', 'h3'], permissions: '0644', modified: '2026-01-02T00:00:00.000Z', created: '2026-01-01T00:00:00.000Z' },
		{ path: 'b.bin', size: 10, checksums: ['h4'] },
	],
	directories: [{ path: 'dir', permissions: '0755', modified: '2026-01-02T00:00:00.000Z' }],
	links: [{ path: 'dir/link', target: 'a.bin', hardlink: false, modified: '2026-01-02T00:00:00.000Z' }],
} satisfies IStoredLISH;

function handlersServing(manifest: IStoredLISH): ReturnType<typeof initLISHnetsHandlers> {
	const stream = {
		status: 'open',
		send() {},
		close: async () => {},
		async *[Symbol.asyncIterator]() {
			yield lpEncode.single(codecEncode({ manifest })).subarray();
		},
	};
	const networks = { getRunningNetwork: () => ({ dialProtocolByPeerId: async () => ({ stream }) }) } as never;
	return initLISHnetsHandlers(
		networks,
		{ getPublisher: () => undefined } as never,
		() => {},
		{ get: () => undefined } as never,
		(async () => ({})) as never,
		async op => op(),
		new AbortController().signal
	);
}

describe('lishnets.getPeerLish detail shape', () => {
	it('answers the pre-summary shape plus the chunk count', async () => {
		const detail = await handlersServing(MANIFEST).getPeerLish({ lishID: MANIFEST.id, peerID: 'peer-1', networkID: 'net-1' });
		expect(detail).toEqual({
			id: MANIFEST.id,
			name: 'Shape',
			description: 'From a peer',
			created: MANIFEST.created,
			chunkSize: 1024,
			checksumAlgo: 'sha256',
			totalSize: 2510,
			totalChunks: 4,
			fileCount: 2,
			directoryCount: 1,
			files: [
				{ path: 'dir/a.bin', size: 2500, permissions: '0644', modified: '2026-01-02T00:00:00.000Z', created: '2026-01-01T00:00:00.000Z' },
				{ path: 'b.bin', size: 10 },
			],
			directories: MANIFEST.directories,
			links: MANIFEST.links,
		});
	});
});
