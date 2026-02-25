import { type HashAlgorithm } from '@shared';

/**
 * Calculate a checksum for a file chunk.
 * Shared between single-threaded path (lish.ts) and worker (checksum-worker.ts).
 */
export async function calculateChecksum(file: ReturnType<typeof Bun.file>, offset: number, chunkSize: number, algo: HashAlgorithm): Promise<string> {
	const end = Math.min(offset + chunkSize, file.size);
	const chunk = file.slice(offset, end);
	const buffer = await chunk.arrayBuffer();
	const hasher = new Bun.CryptoHasher(algo as any);
	hasher.update(buffer);
	return hasher.digest('hex');
}
