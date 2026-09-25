import { describe, expect, it } from 'bun:test';
import { CodedError, ErrorCodes, validateLISHStructure, type ILISH } from '@shared';

/**
 * The entries of a manifest must describe one tree. Two entries at one path, or a file where
 * the tree needs a directory, would leave the writer to pick one silently.
 */
describe('manifest entry tree', () => {
	const file = (path: string) => ({ path, size: 4, checksums: ['c1'] });
	const lish = (files: unknown[], directories?: unknown[], links?: unknown[]): ILISH => ({ id: 'x', created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', files, directories, links }) as unknown as ILISH;
	const detail = (manifest: ILISH): string | undefined => {
		try {
			validateLISHStructure(manifest, 1024);
			return undefined;
		} catch (error) {
			expect((error as CodedError).code).toBe(ErrorCodes.LISH_INVALID_MANIFEST);
			return (error as CodedError).detail;
		}
	};

	it('accepts a directory that repeats an implicit parent', () => {
		expect(detail(lish([file('a/b.bin'), file('a/c/d.bin')], [{ path: 'a' }, { path: 'a/c' }, { path: 'e' }], [{ path: 'a/l', target: 'b.bin' }]))).toBeUndefined();
		// `a b` sorts between `a` and `a/...` in plain order; it is not a descendant of `a`.
		expect(detail(lish([file('a'), file('a b'), file('a!')]))).toBeUndefined();
	});

	it('refuses two entries at one path, whatever they are', () => {
		expect(detail(lish([file('a.bin'), file('a.bin')]))).toBe('duplicate entry path: "a.bin"');
		expect(detail(lish([file('a.bin')], [{ path: 'a.bin' }]))).toBe('duplicate entry path: "a.bin"');
		expect(detail(lish([file('a.bin')], [], [{ path: 'a.bin', target: 'x' }]))).toBe('duplicate entry path: "a.bin"');
		expect(detail(lish([], [{ path: 'd' }, { path: 'd' }]))).toBe('duplicate entry path: "d"');
	});

	it('refuses a file or link where a directory is needed', () => {
		expect(detail(lish([file('a'), file('a/b.bin')]))).toBe('entry path is also a directory: "a"');
		expect(detail(lish([file('a/b'), file('z')], [{ path: 'a/b/c' }]))).toBe('entry path is also a directory: "a/b"');
		expect(detail(lish([file('x/y.bin')], [], [{ path: 'x', target: '/elsewhere' }]))).toBe('entry path is also a directory: "x"');
	});

	it('refuses empty, dot and NUL components instead of rewriting them', () => {
		for (const path of ['a//b', '/a', 'a/', './a', 'a/./b', `a${String.fromCharCode(0)}b`]) expect(detail(lish([file(path)]))).toMatch(/^(empty or '\.' path component|NUL in path): /);
	});

	it('checks the tree of a manifest without files', () => {
		expect(detail(lish(undefined as unknown as unknown[], [{ path: 'd' }], [{ path: 'd', target: 'x' }]))).toBe('duplicate entry path: "d"');
	});

	it('stays fast on deep paths', () => {
		const deep = Array.from({ length: 2000 }, (_, i) => `${'d/'.repeat(1000)}f${i}`);
		const start = performance.now();
		expect(detail(lish(deep.map(file)))).toBeUndefined();
		expect(performance.now() - start).toBeLessThan(2000);
	});
});
