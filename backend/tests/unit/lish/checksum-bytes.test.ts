import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { SUPPORTED_ALGOS } from '@shared';
import { mkdtempSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { checksumBytes } from '../../../src/lish/checksum.ts';

describe('checksumBytes', () => {
	const data = new Uint8Array(70_000).map((_, i) => (i * 7) & 0xff).subarray(5, 65_000);
	let digest: ReturnType<typeof spyOn> | undefined;

	afterEach(() => digest?.mockRestore());

	it('matches Bun.CryptoHasher for every supported algorithm, on a view into a larger buffer', async () => {
		for (const algo of SUPPORTED_ALGOS) {
			const expected = new Bun.CryptoHasher(algo as any).update(data).digest('hex');
			expect(await checksumBytes(data, algo)).toBe(expected);
		}
	});

	it('hashes only the bytes of a Buffer view and leaves its shared backing store usable', async () => {
		const backing = new Uint8Array(64).map((_, i) => i);
		const view = Buffer.from(backing.buffer, 8, 16);
		for (const algo of SUPPORTED_ALGOS) {
			const expected = new Bun.CryptoHasher(algo as any).update(view).digest('hex');
			expect(await checksumBytes(view, algo)).toBe(expected);
			expect(backing[63]).toBe(63);
			expect(view[0]).toBe(8);
		}
	});

	it('hashes SHA-2 through WebCrypto, which runs off the main thread, and nothing else', async () => {
		digest = spyOn(crypto.subtle, 'digest');
		await checksumBytes(data, 'sha256');
		await checksumBytes(data, 'sha512');
		expect(digest).toHaveBeenCalledTimes(2);
		await checksumBytes(data, 'sha3-256');
		expect(digest).toHaveBeenCalledTimes(2);
	});

	it('keeps the main thread free while hashing algorithms WebCrypto lacks', async () => {
		const big = new Uint8Array(32 * 1024 * 1024).fill(3);
		for (const algo of ['sha3-256', 'blake2b512'] as const) {
			const expected = new Bun.CryptoHasher(algo).update(big).digest('hex');
			let timerRan = false;
			setTimeout(() => (timerRan = true), 0);
			const result = await checksumBytes(big, algo);
			expect(result).toBe(expected);
			// Hashed on the main thread, the result would be ready before the event loop ran any timer.
			expect(timerRan).toBe(true);
		}
	});

	it('finishes every pending job on the main thread and lets the process exit when one worker dies', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lish-checksum-pool-'));
		// Job 1 kills its worker; the others would be answered late, after the failure took them over.
		writeFileSync(join(dir, 'worker.js'), `self.onmessage = e => { if (e.data.index === 1) throw new Error('worker died'); setTimeout(() => self.postMessage({ index: e.data.index, checksum: 'late' }), 300); };`);
		const slashes = (path: string): string => path.replaceAll('\\', '/');
		const module = slashes(resolve(import.meta.dir, '../../../src/lish/checksum.ts'));
		const workerPath = slashes(join(dir, 'worker.js'));
		writeFileSync(
			join(dir, 'main.ts'),
			`import { BytesChecksumPool } from '${module}';
const pool = new BytesChecksumPool('${workerPath}', 3);
const jobs = [1, 2, 3].map(() => pool.checksum(new Uint8Array(4), 'sha3-256').catch(() => 'failed'));
console.log((await Promise.all(jobs)).join(','));`
		);
		const child = Bun.spawn([process.execPath, 'run', join(dir, 'main.ts')], { stdout: 'pipe', stderr: 'pipe' });
		const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
		if (!exited) child.kill();
		expect(exited).toBe(true);
		const expected = new Bun.CryptoHasher('sha3-256').update(new Uint8Array(4)).digest('hex');
		expect((await new Response(child.stdout).text()).trim()).toBe([expected, expected, expected].join(','));
	}, 10000);
});
