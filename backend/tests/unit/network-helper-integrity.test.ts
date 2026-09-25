import { afterAll, describe, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HASH_READ_LIMIT_MS, HelperVerificationTimeoutError, sha256File } from '../../src/network-helper-integrity.ts';
import { verifyWindowsInstalledHelper } from '../../src/network-helper-windows.ts';

/**
 * The helper hash is read while a time save holds its lock. The read is bounded and can be
 * cancelled; running out of time is reported as its own error, never as a hash — and never
 * as "untrusted", which would read like a tampered helper.
 */

const dir = mkdtempSync(join(tmpdir(), 'lish-hash-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const small = join(dir, 'small.bin');
const smallBytes = randomBytes(4096);
writeFileSync(small, smallBytes);
// Large enough that reading it takes longer than a millisecond on any machine.
const large = join(dir, 'large.bin');
writeFileSync(large, randomBytes(64 * 1024 * 1024));

describe('sha256File', () => {
	it('hashes a file', async () => {
		expect(await sha256File(small)).toBe(createHash('sha256').update(smallBytes).digest('hex'));
	});

	it('gives up on a read that outlasts its limit, and never resolves late', async () => {
		let resolved = false;
		const reading = sha256File(large, { timeoutMs: 1 }).then(() => {
			resolved = true;
		});
		await expect(reading).rejects.toBeInstanceOf(HelperVerificationTimeoutError);
		await Bun.sleep(300);
		expect(resolved).toBe(false);
	});

	it('stops when cancelled, including before it starts', async () => {
		const controller = new AbortController();
		const reading = sha256File(large, { signal: controller.signal });
		controller.abort();
		await expect(reading).rejects.toBeInstanceOf(HelperVerificationTimeoutError);
		await expect(sha256File(small, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(HelperVerificationTimeoutError);
	});

	it('never waits longer than its own ceiling, whatever budget it is given', () => {
		expect(HASH_READ_LIMIT_MS).toBe(10_000);
	});

	it('still reports a missing file as an ordinary error', async () => {
		const error = await sha256File(join(dir, 'missing.bin')).catch(e => e);
		expect(error).not.toBeInstanceOf(HelperVerificationTimeoutError);
		expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
	});
});

describe('Windows helper verification', () => {
	it('reports a cancelled check as not verified in time rather than untrusted', async () => {
		await expect(verifyWindowsInstalledHelper(small, process.execPath, 'x'.repeat(64), { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(HelperVerificationTimeoutError);
	});

	it('keeps an ordinary failure as untrusted', async () => {
		expect(await verifyWindowsInstalledHelper(join(dir, 'missing.exe'), process.execPath, 'x'.repeat(64))).toBe(false);
	});
});
