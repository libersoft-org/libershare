import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { SUPPORTED_ALGOS } from '@shared';
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

	it('hashes SHA-2 through WebCrypto, which runs off the main thread, and nothing else', async () => {
		digest = spyOn(crypto.subtle, 'digest');
		await checksumBytes(data, 'sha256');
		await checksumBytes(data, 'sha512');
		expect(digest).toHaveBeenCalledTimes(2);
		await checksumBytes(data, 'sha3-256');
		expect(digest).toHaveBeenCalledTimes(2);
	});
});
