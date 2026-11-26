/**
 * Unit tests for what the UI says about a LISH that is not verified
 * (`src/scripts/lishVerification.ts`). The module is pure, so it runs under
 * `bun test` without the Svelte runtime.
 */
import { test, expect } from 'bun:test';
import { checkRows, unverifiedOffer, unverifiedQuestionKey, verificationKey } from '../../src/scripts/lishVerification.ts';

const DERIVED_ID = '123add53-1166-8c2c-b024-1428dd1104aa';
const RANDOM_ID = 'a0000000-0000-4000-8000-000000000001';
const VERIFIED = { signed: true, signatureValid: true, idMatchesPublisher: true };

function held(code: string, checks: object, token: string | undefined = 'token-1'): unknown {
	return { code, detail: JSON.stringify({ checks, ...(token ? { token } : {}) }) };
}

test('reads the held LISH out of a backend error and names it', () => {
	const offer = unverifiedOffer(held('LISH_UNSIGNED', { signed: false }), { id: RANDOM_ID, name: 'Holiday' });
	expect(offer).toEqual({ code: 'LISH_UNSIGNED', checks: { signed: false }, token: 'token-1', id: RANDOM_ID, name: 'Holiday' });
	// Without a name the ID stands in for it.
	expect(unverifiedOffer(held('LISH_UNSIGNED', { signed: false }), { id: RANDOM_ID })?.name).toBe(RANDOM_ID);
});

test('takes any other error for what it is', () => {
	expect(unverifiedOffer({ code: 'LISH_ALREADY_EXISTS', detail: RANDOM_ID }, { id: RANDOM_ID })).toBeNull();
	// The same code from a manifest nobody was asked about carries plain text.
	expect(unverifiedOffer({ code: 'LISH_INVALID_SIGNATURE', detail: 'signature does not match the manifest' }, { id: RANDOM_ID })).toBeNull();
	expect(unverifiedOffer(new Error('plain'), { id: RANDOM_ID })).toBeNull();
	expect(unverifiedOffer(null, { id: RANDOM_ID })).toBeNull();
});

test('asks a different question for each reason', () => {
	expect(unverifiedQuestionKey({ code: 'LISH_UNSIGNED', id: RANDOM_ID })).toBe('lish.unverified.askUnsigned');
	expect(unverifiedQuestionKey({ code: 'LISH_INVALID_SIGNATURE', id: DERIVED_ID })).toBe('lish.unverified.askInvalidSignature');
	expect(unverifiedQuestionKey({ code: 'LISH_ID_MISMATCH', id: DERIVED_ID })).toBe('lish.unverified.askIDMismatch');
});

test('says the signature was taken off when an unsigned LISH has a derived ID', () => {
	expect(unverifiedQuestionKey({ code: 'LISH_UNSIGNED', id: DERIVED_ID })).toBe('lish.unverified.askSignatureRemoved');
});

test('calls a LISH verified only when every check passed', () => {
	expect(verificationKey(VERIFIED)).toBe('lish.checks.verified');
	for (const checks of [{ signed: false }, { ...VERIFIED, signatureValid: false }, { ...VERIFIED, idMatchesPublisher: false }, undefined]) {
		expect(verificationKey(checks)).toBe('lish.checks.unverified');
	}
});

test('lists one row for an unsigned LISH and three for a signed one', () => {
	expect(checkRows({ signed: false })).toEqual([{ labelKey: 'lish.checks.signed', passed: false }]);
	expect(checkRows({ signed: true, signatureValid: false, idMatchesPublisher: true })).toEqual([
		{ labelKey: 'lish.checks.signed', passed: true },
		{ labelKey: 'lish.checks.signatureValid', passed: false },
		{ labelKey: 'lish.checks.idMatchesPublisher', passed: true },
	]);
});
