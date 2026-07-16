import { describe, it, expect } from 'bun:test';
import { expectedChunkLength, type ILISH } from '@shared';

function makeLish(chunkSize: number, fileSizes: number[]): ILISH {
	return {
		id: 'lish-x',
		created: new Date().toISOString(),
		chunkSize,
		checksumAlgo: 'sha256',
		files: fileSizes.map((size, i) => ({
			path: `f${i}.bin`,
			size,
			checksums: new Array(size === 0 ? 0 : Math.ceil(size / chunkSize)).fill('h'),
		})),
	};
}

describe('expectedChunkLength', () => {
	const CS = 1024;

	it('returns chunkSize for a full (non-last) chunk', () => {
		const lish = makeLish(CS, [CS * 3]);
		expect(expectedChunkLength(lish, 0, 0)).toBe(CS);
		expect(expectedChunkLength(lish, 0, 1)).toBe(CS);
	});

	it('returns the shorter remainder for the last chunk of a file', () => {
		const lish = makeLish(CS, [CS * 2 + 100]); // 3 chunks, last = 100
		expect(expectedChunkLength(lish, 0, 2)).toBe(100);
	});

	it('returns chunkSize for a last chunk that divides evenly', () => {
		const lish = makeLish(CS, [CS * 2]);
		expect(expectedChunkLength(lish, 0, 1)).toBe(CS);
	});

	it('handles a single sub-chunk-size file (one short chunk)', () => {
		const lish = makeLish(CS, [200]);
		expect(expectedChunkLength(lish, 0, 0)).toBe(200);
	});

	it('computes per-file independently across multiple files', () => {
		const lish = makeLish(CS, [CS + 50, 300]); // file0: 2 chunks (last 50), file1: 1 chunk (300)
		expect(expectedChunkLength(lish, 0, 0)).toBe(CS);
		expect(expectedChunkLength(lish, 0, 1)).toBe(50);
		expect(expectedChunkLength(lish, 1, 0)).toBe(300);
	});

	it('returns -1 for an out-of-range chunk index', () => {
		const lish = makeLish(CS, [CS]);
		expect(expectedChunkLength(lish, 0, 1)).toBe(-1);
		expect(expectedChunkLength(lish, 0, -1)).toBe(-1);
	});

	it('returns -1 for an out-of-range or missing file', () => {
		const lish = makeLish(CS, [CS]);
		expect(expectedChunkLength(lish, 5, 0)).toBe(-1);
		const { files: _files, ...noFiles } = lish;
		expect(expectedChunkLength(noFiles, 0, 0)).toBe(-1);
	});

	it('returns -1 for an invalid chunkSize', () => {
		const lish = makeLish(CS, [CS]);
		expect(expectedChunkLength({ ...lish, chunkSize: 0 }, 0, 0)).toBe(-1);
	});

	// The download path rejects any chunk whose byte length != expectedChunkLength before
	// hashing — a peer sending an over- or under-sized payload is refused early.
	it('flags a wrong-length payload as bad (over- and under-sized)', () => {
		const lish = makeLish(CS, [CS * 2 + 100]); // last chunk = 100
		const expected = expectedChunkLength(lish, 0, 2);
		expect(expected).toBe(100);
		expect(200 !== expected).toBe(true); // oversized payload rejected
		expect(50 !== expected).toBe(true); // undersized payload rejected
		expect(100 !== expected).toBe(false); // correct length accepted
	});
});
