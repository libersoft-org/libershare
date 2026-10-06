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

// The SHA-2 checksums WebCrypto computes. Its digest runs off the main thread, so hashing a
// downloaded chunk does not stall the event loop that receives and decrypts the next ones.
const WEB_DIGEST: Partial<Record<HashAlgorithm, string>> = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };

/** Hex checksum of bytes in memory; SHA-2 off the main thread, other algorithms on it. */
export async function checksumBytes(data: Uint8Array, algo: HashAlgorithm): Promise<string> {
	const web = WEB_DIGEST[algo];
	if (web) return Buffer.from(await crypto.subtle.digest(web, data as Uint8Array<ArrayBuffer>)).toString('hex');
	const hasher = new Bun.CryptoHasher(algo as any);
	hasher.update(data);
	return hasher.digest('hex');
}
