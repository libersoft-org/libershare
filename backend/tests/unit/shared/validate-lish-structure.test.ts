import { describe, it, expect } from 'bun:test';
import { validateLISHStructure, type ILISH, ErrorCodes } from '@shared';
const MAX = 100 * 1024 * 1024;

function makeLish(overrides: Partial<ILISH> = {}): ILISH {
	return {
		id: 'test-id',
		created: '2026-01-01T00:00:00Z',
		chunkSize: 1024 * 1024,
		checksumAlgo: 'sha256',
		...overrides,
	};
}

describe('validateLISHStructure', () => {
	it('accepts a valid LISH with no files', () => expect(() => validateLISHStructure(makeLish(), MAX)).not.toThrow());
	it('accepts a valid LISH with files whose checksum count matches', () => {
		const lish = makeLish({
			chunkSize: 1024,
			files: [
				{ path: 'a.bin', size: 2048, checksums: ['h1', 'h2'] }, // exactly 2 chunks
				{ path: 'b.bin', size: 2049, checksums: ['h1', 'h2', 'h3'] }, // 3 chunks (last partial)
				{ path: 'empty', size: 0, checksums: [] },
			],
		});
		expect(() => validateLISHStructure(lish, MAX)).not.toThrow();
	});
	it('rejects chunkSize <= 0', () => expect(() => validateLISHStructure(makeLish({ chunkSize: 0 }), MAX)).toThrow(ErrorCodes.LISH_INVALID_CHUNK_SIZE));
	it('rejects non-finite chunkSize', () => expect(() => validateLISHStructure(makeLish({ chunkSize: Number.POSITIVE_INFINITY }), MAX)).toThrow(ErrorCodes.LISH_INVALID_CHUNK_SIZE));
	it('rejects chunkSize above the limit', () => expect(() => validateLISHStructure(makeLish({ chunkSize: 200 * 1024 * 1024 }), 100 * 1024 * 1024)).toThrow(ErrorCodes.LISH_CHUNK_SIZE_TOO_LARGE));
	it('accepts chunkSize exactly at the limit', () => expect(() => validateLISHStructure(makeLish({ chunkSize: 1024 }), 1024)).not.toThrow());
	it('rejects file with too few checksums', () => expect(() => validateLISHStructure(makeLish({ chunkSize: 1024, files: [{ path: 'a.bin', size: 4096, checksums: ['h1', 'h2'] }] }), MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST)); // expected 4
	it('rejects file with too many checksums', () => expect(() => validateLISHStructure(makeLish({ chunkSize: 1024, files: [{ path: 'a.bin', size: 1024, checksums: ['h1', 'h2'] }] }), MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST)); // expected 1
	it('rejects non-empty file with empty checksums', () => expect(() => validateLISHStructure(makeLish({ chunkSize: 1024, files: [{ path: 'a.bin', size: 1, checksums: [] }] }), MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST));
	it('rejects empty file with non-empty checksums', () => expect(() => validateLISHStructure(makeLish({ chunkSize: 1024, files: [{ path: 'empty', size: 0, checksums: ['h1'] }] }), MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST));
});
