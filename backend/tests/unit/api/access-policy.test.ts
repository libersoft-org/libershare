import { describe, expect, it } from 'bun:test';
import { assertUsableToken, InvalidTokenError, requestHasToken } from '../../../src/api/access-policy.ts';

describe('assertUsableToken', () => {
	for (const [name, token] of [
		['missing', undefined],
		['empty', ''],
		['whitespace only', '   '],
		['leading whitespace', ' tok-9f3a7c'],
		['trailing whitespace', 'tok-9f3a7c '],
	] as const) {
		it(`refuses a ${name} token without echoing it`, () => {
			let error: unknown;
			try {
				assertUsableToken(token);
			} catch (e) {
				error = e;
			}
			expect(error).toBeInstanceOf(InvalidTokenError);
			if (token && token.trim()) expect((error as Error).message).not.toContain(token.trim());
		});
	}

	it('accepts a random token', () => {
		expect(() => assertUsableToken('a1b2c3d4e5')).not.toThrow();
	});
});

describe('requestHasToken', () => {
	const url = (query: string) => new URL(`ws://127.0.0.1:1158/${query}`);

	it('accepts exactly one matching token', () => {
		expect(requestHasToken(url('?token=s3cret'), 's3cret')).toBe(true);
	});

	it('refuses a missing, different, shorter, longer or one-byte-different token', () => {
		for (const q of ['', '?token=', '?token=s3cre', '?token=s3cret!', '?token=s3creT', '?other=s3cret']) expect(requestHasToken(url(q), 's3cret')).toBe(false);
	});

	it('refuses a duplicated token parameter even when one copy matches', () => {
		expect(requestHasToken(url('?token=s3cret&token=s3cret'), 's3cret')).toBe(false);
		expect(requestHasToken(url('?token=wrong&token=s3cret'), 's3cret')).toBe(false);
	});
});
