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

	// Untrusted peer input: malformed shapes must yield a CodedError, never a native TypeError.
	// toThrow(<code>) also guards the regression — a TypeError message would not contain the code.
	it('rejects a null manifest', () => expect(() => validateLISHStructure(null as unknown as ILISH, MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST));
	it('rejects a non-object manifest', () => expect(() => validateLISHStructure(42 as unknown as ILISH, MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST));
	it('rejects files that is not an array', () => expect(() => validateLISHStructure({ ...makeLish(), files: 5 } as unknown as ILISH, MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST));
	it('rejects a null file entry', () => expect(() => validateLISHStructure({ ...makeLish(), files: [null] } as unknown as ILISH, MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST));
	// Explicit size/chunkSize validation — the checksum-count equation alone lets these through.
	it('rejects a negative file size (the ceil(-0) trick)', () => expect(() => validateLISHStructure(makeLish({ chunkSize: 1024, files: [{ path: 'a.bin', size: -5, checksums: [] }] }), MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST));
	it('rejects a string file size', () => expect(() => validateLISHStructure({ ...makeLish({ chunkSize: 1024 }), files: [{ path: 'a.bin', size: '1024', checksums: ['h1'] }] } as unknown as ILISH, MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST));
	it('rejects a float file size', () => expect(() => validateLISHStructure(makeLish({ chunkSize: 1024, files: [{ path: 'a.bin', size: 1023.5, checksums: ['h1'] }] }), MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST));
	it('rejects a float chunkSize', () => expect(() => validateLISHStructure(makeLish({ chunkSize: 1024.5 }), MAX)).toThrow(ErrorCodes.LISH_INVALID_CHUNK_SIZE));

	// Presence vs truthiness: falsy non-array `files` is malformed, only absence means metadata-only.
	it('rejects files: null', () => expect(() => validateLISHStructure({ ...makeLish(), files: null } as unknown as ILISH, MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST));
	it('rejects files: false', () => expect(() => validateLISHStructure({ ...makeLish(), files: false } as unknown as ILISH, MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST));

	// A checksum shared by slots with different expected lengths is unsatisfiable — one
	// payload cannot be both full-length and shorter; the duplicate-slot write path would
	// write past the shorter file tail.
	it('rejects a checksum shared by a full chunk and a shorter last chunk', () => {
		const lish = makeLish({
			chunkSize: 1024,
			files: [
				{ path: 'full.bin', size: 1024, checksums: ['dup'] },
				{ path: 'short.bin', size: 1, checksums: ['dup'] },
			],
		});
		expect(() => validateLISHStructure(lish, MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST);
	});
	it('rejects a checksum shared by two last chunks of different lengths', () => {
		const lish = makeLish({
			chunkSize: 1024,
			files: [
				{ path: 'a.bin', size: 1, checksums: ['dup'] },
				{ path: 'b.bin', size: 2, checksums: ['dup'] },
			],
		});
		expect(() => validateLISHStructure(lish, MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST);
	});
	it('accepts duplicate checksums whose slots all expect the same length', () => {
		const lish = makeLish({
			chunkSize: 1024,
			files: [
				{ path: 'a.bin', size: 1500, checksums: ['f', 's'] }, // full + short last
				{ path: 'copy.bin', size: 1500, checksums: ['f', 's'] }, // identical file — same lengths
				{ path: 'rep.bin', size: 2048, checksums: ['x', 'x'] }, // repeated full block within one file
			],
		});
		expect(() => validateLISHStructure(lish, MAX)).not.toThrow();
	});
});

describe('validateLISHStructure — optional arrays', () => {
	it('rejects directories that is not an array', () => expect(() => validateLISHStructure({ ...makeLish(), directories: {} } as unknown as ILISH, MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST));
	it('rejects links that is not an array', () => expect(() => validateLISHStructure({ ...makeLish(), links: {} } as unknown as ILISH, MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST));
	it('accepts absent directories and links', () => expect(() => validateLISHStructure(makeLish(), MAX)).not.toThrow());
});

describe('validateLISHStructure — untrusted field types', () => {
	it('rejects an unsupported checksumAlgo', () => expect(() => validateLISHStructure(makeLish({ checksumAlgo: 'md5' as never }), MAX)).toThrow(ErrorCodes.LISH_UNSUPPORTED_CHECKSUM));
	it('rejects a non-string file path', () => expect(() => validateLISHStructure({ ...makeLish({ chunkSize: 1024 }), files: [{ path: {}, size: 1024, checksums: ['h1'] }] } as unknown as ILISH, MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST));
	it('rejects a non-string checksum entry', () => expect(() => validateLISHStructure({ ...makeLish({ chunkSize: 1024 }), files: [{ path: 'a.bin', size: 1024, checksums: [{}] }] } as unknown as ILISH, MAX)).toThrow(ErrorCodes.LISH_INVALID_MANIFEST));
});
