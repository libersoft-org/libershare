import { describe, expect, it } from 'bun:test';
import { CodedError, ErrorCodes } from '@shared';
import { assertString } from '../../../src/api/system.ts';

/**
 * `Utils.assertParams` only establishes that a parameter is not `undefined`, so
 * the network RPCs used to hand whatever a client sent — an object, an array, a
 * megabyte-long string — straight to the platform code, where it failed far from
 * the request that caused it. These bounds are the gate in front of that.
 */
describe('assertString', () => {
	it('returns an ordinary value unchanged', () => {
		expect(assertString('{2B1F0E8A-4C3D-4E5F-9A7B-1C2D3E4F5A6B}', 'interfaceID', 64)).toBe('{2B1F0E8A-4C3D-4E5F-9A7B-1C2D3E4F5A6B}');
	});

	it('refuses every shape that is not a string', () => {
		for (const bogus of [{}, [], 42, null, true, ['secret']]) {
			let thrown: CodedError | null = null;
			try {
				assertString(bogus, 'interfaceID', 64);
			} catch (err) {
				thrown = err as CodedError;
			}
			expect(thrown).toBeInstanceOf(CodedError);
			expect(thrown?.code).toBe(ErrorCodes.INVALID_INPUT_TYPE);
		}
	});

	it('refuses an empty value where one is required', () => {
		expect(() => assertString('', 'ssid', 64)).toThrow();
	});

	it('refuses a value past the bound rather than passing it to a child process', () => {
		expect(() => assertString('x'.repeat(65), 'interfaceID', 64)).toThrow();
	});

	it('allows an empty value where the caller permits one', () => {
		// An open network is joined with no passphrase at all.
		expect(assertString('', 'password', 128, 0)).toBe('');
	});

	it('names the offending parameter so the failure is traceable', () => {
		try {
			assertString(42, 'ssid', 64);
			throw new Error('should have thrown');
		} catch (err) {
			expect((err as CodedError).detail).toContain('ssid');
		}
	});
});
