import { describe, expect, it } from 'bun:test';
import { errorName, isTransientError } from '../../src/transient-errors.ts';

describe('transient process errors', () => {
	it.each(['AbortError', 'TimeoutError'])('recognizes Error objects named %s', name => {
		expect(isTransientError(Object.assign(new Error('operation ended'), { name }))).toBe(true);
	});

	it.each(['AbortError', 'TimeoutError'])('recognizes DOMException objects named %s', name => {
		expect(isTransientError(new DOMException('operation ended', name))).toBe(true);
	});

	it.each(['AbortError', 'TimeoutError'])('recognizes the explicit %s name in a cause', name => {
		expect(isTransientError(new Error('socket failure', { cause: Object.assign(new Error('operation ended'), { name }) }))).toBe(true);
		expect(isTransientError(new Error('socket failure', { cause: new DOMException('operation ended', name) }))).toBe(true);
	});

	it('retains custom constructor names even when Error.name is inherited', () => {
		class StreamStateError extends Error {}
		class AbortError extends Error {}
		expect(isTransientError(new StreamStateError('closed'))).toBe(true);
		expect(errorName(new StreamStateError('closed'))).toBe('StreamStateError');
		expect(isTransientError(new Error('wrapped', { cause: new AbortError('cancelled') }))).toBe(true);
	});

	it.each(['AbortError', 'TimeoutError'])('logs the explicit %s name instead of its generic constructor', name => {
		expect(errorName(Object.assign(new Error('operation ended'), { name }))).toBe(name);
		expect(errorName(new DOMException('operation ended', name))).toBe(name);
	});

	it('does not promote unrelated whitelisted cause classes to fatal-error exemptions', () => {
		class StreamStateError extends Error {}
		expect(isTransientError(new Error('outer error', { cause: new StreamStateError('closed') }))).toBe(false);
	});

	it.each([
		new Error('ordinary failure'),
		new TypeError('invalid input'),
		new DOMException('access refused', 'NotAllowedError'),
		new Error('AbortError mentioned in an ordinary message'),
		new Error('wrapped bug', { cause: new TypeError('invalid input') }),
	])('keeps unrelated errors fatal: %s', error => {
		expect(isTransientError(error)).toBe(false);
	});

	it('retains only the existing EventEmitter wrapper patterns', () => {
		expect(isTransientError(new Error('Unhandled error. (AbortError: cancelled)'))).toBe(true);
		expect(isTransientError(new Error('Unhandled error. (ECONNRESET)'))).toBe(true);
		expect(isTransientError(Object.assign(new Error('Unhandled error'), { context: { message: 'stream timed out' } }))).toBe(true);
		expect(isTransientError(new Error('Unhandled error. (TypeError: invalid input)'))).toBe(false);
	});

	it('requires both the unavailable-address code and bind operation', () => {
		expect(isTransientError(Object.assign(new Error('bind EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' }))).toBe(true);
		expect(isTransientError(Object.assign(new Error('connect EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' }))).toBe(false);
		expect(isTransientError(Object.assign(new Error('bind EACCES'), { code: 'EACCES' }))).toBe(false);
	});
});
