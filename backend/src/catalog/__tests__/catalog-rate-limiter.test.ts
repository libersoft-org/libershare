import { describe, test, expect, beforeEach } from 'bun:test';
import { CatalogRateLimiter, RATE_LIMITS } from '../catalog-rate-limiter.ts';

let limiter: CatalogRateLimiter;

beforeEach(() => {
	limiter = new CatalogRateLimiter();
});

describe('CatalogRateLimiter', () => {
	test('allows first operation', () => {
		expect(limiter.check('peer1')).toBe('allow');
	});

	test('allows up to maxOpsPerPeerPerMinute', () => {
		for (let i = 0; i < RATE_LIMITS.maxOpsPerPeerPerMinute; i++) {
			expect(limiter.check('peer1')).toBe('allow');
		}
	});

	test('rejects after exceeding per-peer limit', () => {
		for (let i = 0; i < RATE_LIMITS.maxOpsPerPeerPerMinute; i++) {
			limiter.check('peer1');
		}
		expect(limiter.check('peer1')).toBe('reject');
	});

	test('different peers have independent limits', () => {
		for (let i = 0; i < RATE_LIMITS.maxOpsPerPeerPerMinute; i++) {
			limiter.check('peer1');
		}
		expect(limiter.check('peer1')).toBe('reject');
		expect(limiter.check('peer2')).toBe('allow');
	});

	test('rejects after exceeding global limit', () => {
		for (let i = 0; i < RATE_LIMITS.maxOpsGlobalPerMinute; i++) {
			limiter.check(`peer-${i}`);
		}
		expect(limiter.check('new-peer')).toBe('reject');
	});

	test('reset clears all state', () => {
		for (let i = 0; i < RATE_LIMITS.maxOpsPerPeerPerMinute; i++) {
			limiter.check('peer1');
		}
		expect(limiter.check('peer1')).toBe('reject');
		limiter.reset();
		expect(limiter.check('peer1')).toBe('allow');
	});
});
