import { describe, expect, it } from 'bun:test';
import { CodedError, ErrorCodes, MAX_MANIFEST_PATH_BYTES, validateLISHStructure, type ILISH } from '@shared';

/**
 * A manifest from a peer or an imported file is checked field by field before anything stores
 * or indexes it: text fields and paths have byte limits, checksums are short ASCII, entries of
 * every list are objects with string paths and the declared total size stays a safe integer.
 */
describe('manifest field limits', () => {
	const base = (extra: Record<string, unknown> = {}): ILISH => ({ id: 'x', created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'a.bin', size: 4, checksums: ['c1'] }], ...extra }) as unknown as ILISH;
	const rejects = (lish: ILISH, maxChunkSize = 1024): string => {
		try {
			validateLISHStructure(lish, maxChunkSize);
		} catch (error) {
			expect((error as CodedError).code).toBe(ErrorCodes.LISH_INVALID_MANIFEST);
			return (error as CodedError).detail ?? '';
		}
		throw new Error('expected a rejection');
	};
	// 2049 two-byte characters: under the limit in UTF-16 units, over it in UTF-8 bytes.
	const longPath = 'é'.repeat(MAX_MANIFEST_PATH_BYTES / 2 + 1);

	it('accepts fields at their limits', () => {
		const atLimit = 'é'.repeat(MAX_MANIFEST_PATH_BYTES / 2);
		expect(() => validateLISHStructure(base({ id: 'i'.repeat(256), name: 'n'.repeat(1024), description: 'd'.repeat(65536), files: [{ path: atLimit, size: 4, checksums: ['c'.repeat(128)] }], directories: [{ path: 'dir' }], links: [{ path: 'l', target: atLimit }] }), 1024)).not.toThrow();
	});

	it('refuses a missing or oversized id, name and description', () => {
		expect(rejects(base({ id: undefined }))).toContain('id is not a string');
		expect(rejects(base({ id: 'i'.repeat(257) }))).toContain('id is longer than 256 bytes');
		expect(rejects(base({ name: 'n'.repeat(1025) }))).toContain('name is longer');
		expect(rejects(base({ name: null }))).toContain('name is not a string');
		expect(rejects(base({ description: 'd'.repeat(65537) }))).toContain('description is longer');
	});

	it('refuses paths and link targets over the byte limit', () => {
		expect(rejects(base({ files: [{ path: longPath, size: 4, checksums: ['c1'] }] }))).toContain('file path is longer');
		expect(rejects(base({ directories: [{ path: longPath }] }))).toContain('directory path is longer');
		expect(rejects(base({ links: [{ path: longPath, target: 'a.bin' }] }))).toContain('link path is longer');
		expect(rejects(base({ links: [{ path: 'l', target: longPath }] }))).toContain('link target path is longer');
	});

	it('refuses directory and link entries that are not objects with string paths', () => {
		expect(rejects(base({ directories: [null] }))).toBe('directory entry is not an object');
		expect(rejects(base({ directories: [{ path: { nested: 'x'.repeat(1e6) } }] }))).toBe('directory path is not a string: object');
		expect(rejects(base({ links: [7] }))).toBe('link entry is not an object');
		expect(rejects(base({ links: [{ path: 'l', target: 5 }] }))).toBe('link target path is not a string: 5');
	});

	it('refuses long, empty or non-printable checksums', () => {
		for (const checksum of ['c'.repeat(129), '', 'a b', `a${String.fromCharCode(10)}`]) expect(rejects(base({ files: [{ path: 'a.bin', size: 4, checksums: [checksum] }] }))).toContain('invalid checksum');
	});

	it('refuses a declared total size past the safe integer range', () => {
		const chunkSize = 2 ** 52;
		const huge = { path: 'h', size: chunkSize + 1, checksums: ['c1', 'c2'] };
		expect(rejects(base({ chunkSize, files: [huge, { ...huge, path: 'h2' }] }), chunkSize)).toBe('total size is not a safe integer');
		expect(rejects(base({ chunkSize: 2 ** 58, files: [{ path: 'h', size: 2 ** 60, checksums: ['c1', 'c2', 'c3', 'c4'] }] }), 2 ** 58)).toBe('total size is not a safe integer');
	});
});
