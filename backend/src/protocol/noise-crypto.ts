import { pureJsCrypto, type ICryptoInterface } from '@chainsafe/libp2p-noise';
import sodium from 'libsodium-wrappers';

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

// libsodium's WebAssembly ChaCha20-Poly1305 runs about 2.5x faster than the pure-JS one, and every
// byte of every connection goes through it twice (encrypt, decrypt). If the module cannot start,
// connections fall back to the pure-JS cipher.
const sodiumReady: boolean = await sodium.ready.then(
	() => true,
	error => {
		console.warn(`[NET] libsodium unavailable, using pure-JS connection encryption: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
);

/**
 * Noise crypto: ChaCha20-Poly1305 (IETF, RFC 8439 — byte-identical on the wire to any other
 * implementation) from libsodium when available, otherwise the pure-JS one with plain byte
 * views; everything else from the pure-JS crypto. Bun's node:crypto has no ChaCha20-Poly1305.
 */
export const noiseCrypto: ICryptoInterface = sodiumReady
	? {
			...pureJsCrypto,
			chaCha20Poly1305Encrypt: (plaintext, nonce, ad, k) => sodium.crypto_aead_chacha20poly1305_ietf_encrypt(plainBytes(plaintext), ad, null, nonce, k),
			chaCha20Poly1305Decrypt: (ciphertext, nonce, ad, k) => sodium.crypto_aead_chacha20poly1305_ietf_decrypt(null, plainBytes(ciphertext), ad, nonce, k),
		}
	: {
			...pureJsCrypto,
			chaCha20Poly1305Encrypt: (plaintext, nonce, ad, k) => pureJsCrypto.chaCha20Poly1305Encrypt(plainBytes(plaintext), nonce, ad, k),
			chaCha20Poly1305Decrypt: (ciphertext, nonce, ad, k, dst) => pureJsCrypto.chaCha20Poly1305Decrypt(plainBytes(ciphertext), nonce, ad, k, dst),
		};
