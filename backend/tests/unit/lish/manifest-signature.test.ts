import { describe, expect, it } from 'bun:test';
import { generateKeyPair, generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { base32 } from 'multiformats/bases/base32';
import { encodeSignature, ErrorCodes, signedManifestBytes, type ILISH } from '@shared';
import { assertExpectedPublisher, verifyManifestSignature } from '../../../src/lish/manifest-signature.ts';

// Fixed Ed25519 key (32-byte seed + 32-byte public key) so the vector below never changes.
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

function fixedKey() {
	return generateKeyPairFromSeed('Ed25519', SEED);
}

function manifest(overrides: Record<string, unknown> = {}): ILISH {
	return { id: 'a0000000-0000-4000-8000-000000000001', name: 'Demo', created: '2026-10-08T10:00:00.000Z', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'a.txt', size: 5, checksums: ['aa', 'bb'] }], ...overrides } as ILISH;
}

async function sign(lish: ILISH, key?: Awaited<ReturnType<typeof fixedKey>>): Promise<ILISH> {
	const signer = key ?? (await fixedKey());
	const withPublisher = { ...lish, publisher: peerIdFromPrivateKey(signer).toString() };
	return { ...withPublisher, signature: encodeSignature(await signer.sign(signedManifestBytes(withPublisher))) };
}

const invalid = { code: ErrorCodes.LISH_INVALID_SIGNATURE };

describe('verifyManifestSignature', () => {
	it('matches a fixed Ed25519 vector', async () => {
		// Ed25519 is deterministic, so the key seed and the manifest pin both values.
		const lish = await sign(manifest());
		expect(lish.publisher).toBe('12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf');
		expect(lish.signature).toBe('YNV3XRf6Tib4n-_lsuva7tHlQY4R9MfCnn-fj7V-vN_WKVMmcIGlmHiTlYAMpOGorhsBHfi5Bi5tls2m_VnrCQ');
		expect(await verifyManifestSignature(lish)).toEqual({ signed: true, publisher: lish.publisher! });
	});

	it('reports an unsigned manifest without error', async () => {
		expect(await verifyManifestSignature(manifest())).toEqual({ signed: false });
	});

	it('rejects any change of signed content that keeps a valid structure', async () => {
		const lish = await sign(manifest());
		for (const change of [{ name: 'Other' }, { created: '2026-10-08T10:00:01.000Z' }, { files: [{ path: 'b.txt', size: 5, checksums: ['aa', 'bb'] }] }, { files: [{ path: 'a.txt', size: 5, checksums: ['aa', 'bc'] }] }]) {
			await expect(verifyManifestSignature({ ...lish, ...change } as ILISH)).rejects.toMatchObject(invalid);
		}
	});

	it('rejects a signature made by another key', async () => {
		const other = await generateKeyPair('Ed25519');
		const forged = { ...(await sign(manifest(), other)), publisher: peerIdFromPrivateKey(await fixedKey()).toString() };
		await expect(verifyManifestSignature(forged)).rejects.toMatchObject(invalid);
	});

	it('rejects a non-Ed25519 publisher', async () => {
		const rsa = await generateKeyPair('RSA', 1024);
		const lish = { ...(await sign(manifest())), publisher: peerIdFromPrivateKey(rsa).toString() };
		await expect(verifyManifestSignature(lish)).rejects.toMatchObject(invalid);
	});

	it('rejects a non-canonical spelling of the publisher, even when signed over it', async () => {
		// The base32 CID form parses to the same Peer ID; the shape check in shared refuses it. The
		// canonical-form check in the backend is defence in depth: no string that passes the shape
		// check is known to parse to a differently spelled Peer ID, so this test does not cover it.
		const key = await fixedKey();
		const cid = peerIdFromPrivateKey(key).toCID().toString(base32);
		const withCid = { ...manifest(), publisher: cid };
		const lish = { ...withCid, signature: encodeSignature(await key.sign(signedManifestBytes(withCid))) };
		await expect(verifyManifestSignature(lish)).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_MANIFEST });
	});

	it('rejects half a signature', async () => {
		const lish = await sign(manifest());
		await expect(verifyManifestSignature({ ...lish, signature: undefined } as unknown as ILISH)).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_MANIFEST });
	});
});

describe('assertExpectedPublisher', () => {
	it('compares against a known, an unsigned or no expectation', () => {
		const signed = { signed: true, publisher: 'P' } as const;
		expect(() => assertExpectedPublisher(signed, 'P')).not.toThrow();
		expect(() => assertExpectedPublisher(signed, undefined)).not.toThrow();
		expect(() => assertExpectedPublisher(signed, 'Q')).toThrow(expect.objectContaining({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH }));
		expect(() => assertExpectedPublisher(signed, null)).toThrow(expect.objectContaining({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH }));
		expect(() => assertExpectedPublisher({ signed: false }, 'P')).toThrow(expect.objectContaining({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH }));
		expect(() => assertExpectedPublisher({ signed: false }, null)).not.toThrow();
	});
});
