import { pureJsCrypto, type ICryptoInterface } from '@chainsafe/libp2p-noise';

// Taken from noise itself: the package resolves its own major of uint8arraylist.
type CipherInput = Parameters<ICryptoInterface['chaCha20Poly1305Encrypt']>[0];

/**
 * The same bytes as a plain `Uint8Array` view — no copy. @noble/ciphers copies every input with
 * `Uint8Array.from`, which Bun runs as a memory copy for a plain `Uint8Array` but element by
 * element for a `Buffer` (about 70 MiB/s). Socket reads and msgpack output are Buffers, so
 * without this view that copy was the largest single cost of every encrypted transfer.
 */
export function plainBytes(data: CipherInput): Uint8Array {
	const bytes = data.subarray();
	return Object.getPrototypeOf(bytes) === Uint8Array.prototype ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * The pure-JS noise crypto (Bun's node:crypto has no ChaCha20-Poly1305) with its cipher inputs
 * passed as plain Uint8Array views; see {@link plainBytes}.
 */
export const noiseCrypto: ICryptoInterface = {
	...pureJsCrypto,
	chaCha20Poly1305Encrypt: (plaintext, nonce, ad, k) => pureJsCrypto.chaCha20Poly1305Encrypt(plainBytes(plaintext), nonce, ad, k),
	chaCha20Poly1305Decrypt: (ciphertext, nonce, ad, k, dst) => pureJsCrypto.chaCha20Poly1305Decrypt(plainBytes(ciphertext), nonce, ad, k, dst),
};
