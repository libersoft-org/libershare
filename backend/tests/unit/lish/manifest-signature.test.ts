import { describe, expect, it } from 'bun:test';
import { generateKeyPair, generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { base32 } from 'multiformats/bases/base32';
import { encodeSignature, ErrorCodes, isDerivedLISHID, signedManifestBytes, type ILISH } from '@shared';
import { deriveLISHID, lishIDMatchesPublisher } from '../../../src/lish/lish-id.ts';
import { assertExpectedPublisher, verifyManifestSignature } from '../../../src/lish/manifest-signature.ts';
import { TEST_NONCE, signFixed, signKeepingID } from '../helpers/signing.ts';

// Fixed Ed25519 key (32-byte seed + 32-byte public key) so the vector below never changes.
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

function fixedKey() {
	return generateKeyPairFromSeed('Ed25519', SEED);
}

function manifest(overrides: Record<string, unknown> = {}): ILISH {
	return { version: 1, id: 'a0000000-0000-4000-8000-000000000001', name: 'Demo', created: '2026-10-08T10:00:00.000Z', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'a.txt', size: 5, checksums: ['aa', 'bb'] }], ...overrides } as ILISH;
}

async function sign(lish: ILISH, key?: Awaited<ReturnType<typeof fixedKey>>): Promise<ILISH> {
	return signFixed(lish, key ?? (await fixedKey()));
}

const invalid = { code: ErrorCodes.LISH_INVALID_SIGNATURE };
// SHA-256 of the fixed publisher followed by the test nonce, with the version and variant bits set.
const FIXED_ID = '123add53-1166-8c2c-b024-1428dd1104aa';

describe('verifyManifestSignature', () => {
	it('matches a fixed Ed25519 vector', async () => {
		// Ed25519 is deterministic, so the key seed, the nonce and the manifest pin all three values.
		const lish = await sign(manifest());
		expect(lish.publisher).toBe('12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf');
		expect(lish.signature).toBe('ZHlpENUcDtrgMTa4toHMdSVzfzpFw-SJuZWBa0C7LP_grm4EMF_ArZlybCnR7B2uRMy2Q2pjBhy8tuK7z5EoCA');
		expect(lish.id).toBe(FIXED_ID);
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
		// The base32 CID form parses to the same Peer ID; here the shape check in shared refuses it.
		const key = await fixedKey();
		const cid = peerIdFromPrivateKey(key).toCID().toString(base32);
		const withCid = { ...manifest(), publisher: cid, nonce: TEST_NONCE };
		const lish = { ...withCid, signature: encodeSignature(await key.sign(signedManifestBytes(withCid))) };
		await expect(verifyManifestSignature(lish)).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_MANIFEST });
	});

	it('rejects a CID spelling that passes the shape check, in the backend canonical check', async () => {
		// For the all-zero seed the base32 CID happens to use only base58 letters ("bafz…"): it passes
		// the shape check and verifies cryptographically; only the canonical comparison refuses it.
		const key = await generateKeyPairFromSeed('Ed25519', new Uint8Array(32));
		const cid = peerIdFromPrivateKey(key).toCID().toString(base32);
		expect(cid).toBe('bafzaajaiaejcao3ke66m5nvefvrkhkgqfjxq243fgikxohpciotdvqciugfvtwrj');
		const withCid = { ...manifest(), publisher: cid, nonce: TEST_NONCE };
		const lish = { ...withCid, signature: encodeSignature(await key.sign(signedManifestBytes(withCid))) };
		await expect(verifyManifestSignature(lish)).rejects.toMatchObject({ ...invalid, detail: 'publisher is not in canonical form' });
	});

	it('rejects half a signature', async () => {
		const lish = await sign(manifest());
		await expect(verifyManifestSignature({ ...lish, signature: undefined } as unknown as ILISH)).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_MANIFEST });
		await expect(verifyManifestSignature({ ...lish, nonce: undefined } as unknown as ILISH)).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_MANIFEST });
	});

	it('rejects a valid signature under an ID the signing key does not derive', async () => {
		// The ID of the fixed key, signed over by another key: the signature itself is in order.
		const owned = await sign(manifest());
		const other = await generateKeyPair('Ed25519');
		const taken = await signKeepingID({ ...manifest(), id: owned.id }, other);
		await expect(verifyManifestSignature(taken)).rejects.toMatchObject({ code: ErrorCodes.LISH_ID_MISMATCH });
		// A random ID under a signature fails the same way.
		await expect(verifyManifestSignature(await signKeepingID(manifest(), other))).rejects.toMatchObject({ code: ErrorCodes.LISH_ID_MISMATCH });
	});
});

describe('deriveLISHID', () => {
	const publisher = '12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf';

	it('matches a fixed vector and has the form of a version 8 UUID', () => {
		const id = deriveLISHID(publisher, TEST_NONCE);
		expect(id).toBe(FIXED_ID);
		expect(isDerivedLISHID(id)).toBe(true);
		expect(isDerivedLISHID('a0000000-0000-4000-8000-000000000001')).toBe(false);
	});

	it('changes with the publisher and with the nonce', () => {
		const id = deriveLISHID(publisher, TEST_NONCE);
		expect(deriveLISHID(publisher, 'B' + TEST_NONCE.slice(1))).not.toBe(id);
		expect(deriveLISHID('12D3KooWAcB6uoHuAPyfsYcwnYTqGNt2biPmSmvbBam9cwmawgzK', TEST_NONCE)).not.toBe(id);
	});

	it('matches only the publisher and nonce it was made from', () => {
		const id = deriveLISHID(publisher, TEST_NONCE);
		expect(lishIDMatchesPublisher({ id, publisher, nonce: TEST_NONCE })).toBe(true);
		expect(lishIDMatchesPublisher({ id, publisher: '12D3KooWAcB6uoHuAPyfsYcwnYTqGNt2biPmSmvbBam9cwmawgzK', nonce: TEST_NONCE })).toBe(false);
		expect(lishIDMatchesPublisher({ id, publisher, nonce: 'B' + TEST_NONCE.slice(1) })).toBe(false);
		expect(lishIDMatchesPublisher({ id, publisher })).toBe(false);
		// One changed bit of the ID is enough.
		expect(lishIDMatchesPublisher({ id: id.slice(0, -1) + (id.endsWith('0') ? '1' : '0'), publisher, nonce: TEST_NONCE })).toBe(false);
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
