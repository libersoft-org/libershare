import { describe, it, expect, beforeEach } from 'bun:test';
import { SpeedLimiter, uploadLimiter, downloadLimiter } from '../../../src/protocol/speed-limiter.ts';

describe('SpeedLimiter', () => {
	let limiter: SpeedLimiter;

	beforeEach(() => {
		limiter = new SpeedLimiter();
	});

	// --- Basic behavior ---

	it('does not throttle when limit is 0 (unlimited)', async () => {
		limiter.setLimit(0);
		const start = Date.now();
		await limiter.throttle(10 * 1024 * 1024); // 10MB
		expect(Date.now() - start).toBeLessThan(50);
	});

	it('does not throttle when under limit', async () => {
		limiter.setLimit(1024); // 1MB/s
		const start = Date.now();
		await limiter.throttle(512 * 1024); // 512KB — under 1MB/s
		expect(Date.now() - start).toBeLessThan(50);
	});

	it('throttles when over limit', async () => {
		limiter.setLimit(100); // 100KB/s = 102400 bytes/s
		// Send 200KB in quick succession — should trigger throttle
		await limiter.throttle(102400); // exactly at limit
		const start = Date.now();
		await limiter.throttle(102400); // over limit — should wait ~1s
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThan(400); // at least some wait
		expect(elapsed).toBeLessThan(2000); // but not forever
	});

	it('setLimit changes limit dynamically', async () => {
		limiter.setLimit(1024); // 1MB/s
		await limiter.throttle(512 * 1024); // under limit, no wait
		limiter.setLimit(512); // 512KB/s — halved
		const start = Date.now();
		await limiter.throttle(512 * 1024); // 512KB more — total 1MB in window at 512KB/s limit
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThan(400); // should wait ~1s
		expect(elapsed).toBeLessThan(2000);
	});

	it('reset clears samples — no throttle after reset', async () => {
		limiter.setLimit(100); // 100KB/s
		await limiter.throttle(200 * 1024); // 200KB — over limit, will wait
		limiter.reset();
		const start = Date.now();
		await limiter.throttle(512); // small amount after reset
		expect(Date.now() - start).toBeLessThan(50); // no wait
	});

	// --- Sliding window behavior ---

	it('window expires after 1 second — old samples ignored', async () => {
		limiter.setLimit(100); // 100KB/s
		await limiter.throttle(102400); // fill window to limit
		// Wait for window to expire
		await new Promise(r => setTimeout(r, 1100));
		const start = Date.now();
		await limiter.throttle(51200); // 50KB — should not throttle (old samples expired)
		expect(Date.now() - start).toBeLessThan(50);
	});

	// --- Multiple concurrent streams (global limit) ---

	it('enforces global limit across concurrent calls', async () => {
		limiter.setLimit(100); // 100KB/s
		const start = Date.now();
		// Simulate 3 concurrent streams each sending 50KB
		await Promise.all([
			limiter.throttle(51200), // stream A: 50KB
			limiter.throttle(51200), // stream B: 50KB
			limiter.throttle(51200), // stream C: 50KB — total 150KB > 100KB limit
		]);
		const elapsed = Date.now() - start;
		// At least one stream should have waited
		expect(elapsed).toBeGreaterThan(200);
	});

	it('two sequential calls within window accumulate', async () => {
		limiter.setLimit(100); // 100KB/s
		await limiter.throttle(51200); // 50KB
		const start = Date.now();
		await limiter.throttle(102400); // +100KB = 150KB total > 100KB limit
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThan(200);
	});

	// --- Edge cases ---

	it('throttle(0) does nothing', async () => {
		limiter.setLimit(1); // 1KB/s
		const start = Date.now();
		await limiter.throttle(0);
		expect(Date.now() - start).toBeLessThan(50);
	});

	it('getLimit returns current limit', () => {
		expect(limiter.getLimit()).toBe(0);
		limiter.setLimit(512);
		expect(limiter.getLimit()).toBe(512 * 1024);
	});

	it('negative kbPerSec clamps to 0', () => {
		limiter.setLimit(-100);
		expect(limiter.getLimit()).toBe(0);
	});

	// --- Pause/resume scenario ---

	it('does not drift after pause — window expires naturally', async () => {
		limiter.setLimit(100); // 100KB/s
		// Upload 100KB
		await limiter.throttle(102400);
		// "Pause" for 2 seconds (no uploads)
		await new Promise(r => setTimeout(r, 1200));
		// Resume — window should be clean (old samples expired)
		const start = Date.now();
		await limiter.throttle(51200); // 50KB — under limit
		expect(Date.now() - start).toBeLessThan(50); // no drift
	});

	// --- Download: multiple Downloader instances share limit ---

	it('downloadLimiter is a singleton shared across imports', () => {
		expect(downloadLimiter).toBeInstanceOf(SpeedLimiter);
		downloadLimiter.setLimit(500);
		expect(downloadLimiter.getLimit()).toBe(500 * 1024);
		downloadLimiter.setLimit(0); // cleanup
	});

	// --- Upload: singleton shared across streams ---

	it('uploadLimiter is a singleton shared across imports', () => {
		expect(uploadLimiter).toBeInstanceOf(SpeedLimiter);
		uploadLimiter.setLimit(200);
		expect(uploadLimiter.getLimit()).toBe(200 * 1024);
		uploadLimiter.setLimit(0); // cleanup
	});

	// --- Realistic scenario: 1MB chunks at 5MB/s ---

	it('realistic: 5 x 1MB chunks at 5MB/s limit — minimal throttle', async () => {
		limiter.setLimit(5120); // 5MB/s
		const start = Date.now();
		for (let i = 0; i < 5; i++) {
			await limiter.throttle(1024 * 1024); // 1MB each
		}
		const elapsed = Date.now() - start;
		// 5MB at 5MB/s = 1 second expected, but first chunk is free
		// With sliding window, should take ~800-1200ms
		expect(elapsed).toBeLessThan(2000);
	});
});
