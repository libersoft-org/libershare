import { describe, expect, it } from 'bun:test';
import { CodedError, formatUntrustedValue, validateLISHStructure, type ILISH } from '@shared';
import { validateImportedLISH } from '../../../src/lish/lish.ts';

/**
 * Validation details built from a peer's manifest go to logs, the database and the screen. They
 * are short and escaped: a hostile path of megabytes or one full of control and bidi characters
 * used to be copied into the error verbatim.
 */
describe('formatUntrustedValue', () => {
	it('keeps a short string as a quoted, escaped fragment', () => {
		expect(formatUntrustedValue('a/b.txt')).toBe('"a/b.txt"');
		const hostile = `x${String.fromCharCode(0x0a, 0x7f, 0x85, 0x2028, 0x202e, 0x2066)}y`;
		const out = formatUntrustedValue(hostile);
		for (const code of [0x0a, 0x7f, 0x85, 0x2028, 0x202e, 0x2066]) expect(out.includes(String.fromCharCode(code))).toBe(false);
		expect(out).toContain('\\u2028');
	});

	it('cuts a long string to 64 units and marks it, without splitting a surrogate pair', () => {
		const out = formatUntrustedValue('a'.repeat(100_000));
		expect(out).toBe(`"${'a'.repeat(64)}"...`);
		const emoji = 'a'.repeat(63) + String.fromCodePoint(0x1f600) + 'tail';
		expect(formatUntrustedValue(emoji)).toBe(`"${'a'.repeat(63)}"...`);
	});

	it('names objects and friends by type without touching them', () => {
		const trap = {
			toString() {
				throw new Error('called');
			},
			toJSON() {
				throw new Error('called');
			},
		};
		expect(formatUntrustedValue(trap)).toBe('object');
		expect(formatUntrustedValue([1, 2])).toBe('array');
		expect(formatUntrustedValue(new Uint8Array(3))).toBe('typed array');
		expect(formatUntrustedValue(() => 1)).toBe('function');
		expect(formatUntrustedValue(Symbol('s'))).toBe('symbol');
		expect(formatUntrustedValue(10n ** 400n)).toBe('bigint');
		expect(formatUntrustedValue(null)).toBe('null');
		expect(formatUntrustedValue(12)).toBe('12');
	});
});

describe('manifest validation details', () => {
	const base = (files: unknown[]): ILISH => ({ id: 'x', created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', files }) as unknown as ILISH;
	const detail = (lish: ILISH): string => {
		try {
			validateLISHStructure(lish, 1024);
		} catch (error) {
			return (error as CodedError).detail ?? '';
		}
		throw new Error('expected a rejection');
	};

	it('bounds a hostile path in every file error', () => {
		const path = `${'p'.repeat(1_000_000)}${String.fromCharCode(0x2028)}`;
		for (const file of [
			{ path, size: -1, checksums: [] },
			{ path, size: 8, checksums: ['a'] },
			{ path, size: 4, checksums: [7] },
		]) {
			const d = detail(base([file]));
			expect(d.length).toBeLessThan(400);
			expect(d.includes(String.fromCharCode(0x2028))).toBe(false);
		}
		expect(detail(base([{ path: { toString: () => 'x'.repeat(1e6) }, size: 1, checksums: ['a'] }]))).toBe('file path is not a string: object');
	});

	it('bounds a hostile chunk size and checksum algorithm', () => {
		expect(detail({ ...base([]), chunkSize: 'z'.repeat(1e6) } as unknown as ILISH).length).toBeLessThan(80);
		expect(detail({ ...base([]), checksumAlgo: 'z'.repeat(1e6) } as unknown as ILISH).length).toBeLessThan(80);
	});
});

describe('imported manifest validation details', () => {
	it('bounds a hostile checksum algorithm from an imported file', () => {
		const algo = `${'z'.repeat(1_000_000)}${String.fromCharCode(0x202e)}`;
		try {
			validateImportedLISH({ id: 'x', created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: algo });
		} catch (error) {
			const d = (error as CodedError).detail ?? '';
			expect(d.length).toBeLessThan(80);
			expect(d.includes(String.fromCharCode(0x202e))).toBe(false);
			return;
		}
		throw new Error('expected a rejection');
	});
});
