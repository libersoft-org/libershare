import { describe, expect, it } from 'bun:test';
import { pureJsCrypto } from '@chainsafe/libp2p-noise';
import { Uint8ArrayList } from 'uint8arraylist';
import { noiseCrypto, plainBytes } from '../../../src/protocol/noise-crypto.ts';

describe('noise crypto inputs', () => {
	it('hands the cipher a plain Uint8Array view of a Buffer, without copying', () => {
		const backing = Buffer.alloc(64, 7);
		const buffer = backing.subarray(8, 40);
		const view = plainBytes(buffer);
		expect(Object.getPrototypeOf(view)).toBe(Uint8Array.prototype);
		expect(view.buffer).toBe(buffer.buffer);
		expect(view.byteOffset).toBe(buffer.byteOffset);
		expect(view.byteLength).toBe(32);
	});

	it('flattens a list into one plain Uint8Array', () => {
		const list = new Uint8ArrayList(Buffer.from([1, 2]), new Uint8Array([3]));
		const view = plainBytes(list as never);
		expect(Object.getPrototypeOf(view)).toBe(Uint8Array.prototype);
		expect([...view]).toEqual([1, 2, 3]);
	});

	it('encrypts and decrypts Buffers exactly like the pure-JS crypto', () => {
		const key = new Uint8Array(32).fill(9);
		const nonce = new Uint8Array(12).fill(1);
		const ad = new Uint8Array(0);
		const plaintext = Buffer.from('chunk payload over a noise stream');
		const sealed = noiseCrypto.chaCha20Poly1305Encrypt(plaintext, nonce, ad, key).subarray();
		expect(sealed).toEqual(pureJsCrypto.chaCha20Poly1305Encrypt(new Uint8Array(plaintext), nonce, ad, key).subarray());
		const opened = noiseCrypto.chaCha20Poly1305Decrypt(Buffer.from(sealed), nonce, ad, key).subarray();
		expect(Buffer.from(opened).toString()).toBe('chunk payload over a noise stream');
	});

	it('stays wire-compatible with the pure-JS cipher in both directions, with associated data', () => {
		const key = new Uint8Array(32).fill(5);
		const nonce = new Uint8Array(12).fill(2);
		const ad = new Uint8Array([1, 2, 3, 4]);
		const plaintext = new Uint8Array(70_000).map((_, i) => i & 0xff);
		const ours = noiseCrypto.chaCha20Poly1305Encrypt(plaintext, nonce, ad, key).subarray();
		expect(pureJsCrypto.chaCha20Poly1305Decrypt(ours, nonce, ad, key).subarray()).toEqual(plaintext);
		const theirs = pureJsCrypto.chaCha20Poly1305Encrypt(plaintext, nonce, ad, key).subarray();
		expect(noiseCrypto.chaCha20Poly1305Decrypt(Buffer.from(theirs), nonce, ad, key).subarray()).toEqual(plaintext);
	});

	it('rejects a tampered ciphertext', () => {
		const key = new Uint8Array(32).fill(5);
		const nonce = new Uint8Array(12);
		const sealed = noiseCrypto.chaCha20Poly1305Encrypt(new Uint8Array(100).fill(1), nonce, new Uint8Array(0), key).subarray().slice();
		sealed[10]! ^= 1;
		expect(() => noiseCrypto.chaCha20Poly1305Decrypt(sealed, nonce, new Uint8Array(0), key)).toThrow();
	});
});
