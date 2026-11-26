import { describe, expect, it } from 'bun:test';
import { generateKeyPair, generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { base32 } from 'multiformats/bases/base32';
import { encodeSignature, ErrorCodes, isDerivedLISHID, signedManifestBytes, unverifiedLISHFromError, type ILISH } from '@shared';
import { deriveLISHID, lishIDMatchesPublisher } from '../../../src/lish/lish-id.ts';
import { ManifestAdmission } from '../../../src/lish/manifest-admission.ts';
import { TEST_NONCE, UNSIGNED, VERIFIED, signFixed, signKeepingID } from '../helpers/signing.ts';

// Fixed Ed25519 key (32-byte seed + 32-byte public key) so the vector below never changes.
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PUBLISHER = '12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf';
// SHA-256 of the fixed publisher followed by the test nonce, with the version and variant bits set.
const FIXED_ID = '123add53-1166-8c2c-b024-1428dd1104aa';

function fixedKey() {
	return generateKeyPairFromSeed('Ed25519', SEED);
}

function manifest(overrides: Record<string, unknown> = {}): ILISH {
	return { version: 1, id: 'a0000000-0000-4000-8000-000000000001', name: 'Demo', created: '2026-10-08T10:00:00.000Z', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'a.txt', size: 5, checksums: ['aa', 'bb'] }], ...overrides } as ILISH;
}

async function sign(lish: ILISH, key?: Awaited<ReturnType<typeof fixedKey>>): Promise<ILISH> {
	return signFixed(lish, key ?? (await fixedKey()));
}

/** Signed correctly, then given another name: the signature no longer matches. */
async function changed(): Promise<ILISH> {
	return { ...(await sign(manifest())), name: 'Other' };
}

/** A valid signature of another key over the fixed key's ID. */
async function takenID(): Promise<ILISH> {
	return signKeepingID({ ...manifest(), id: FIXED_ID }, await generateKeyPair('Ed25519'));
}

describe('ManifestAdmission.check', () => {
	it('matches a fixed Ed25519 vector', async () => {
		// Ed25519 is deterministic, so the key seed, the nonce and the manifest pin all three values.
		const lish = await sign(manifest());
		expect(lish.publisher).toBe(PUBLISHER);
		expect(lish.signature).toBe('ZHlpENUcDtrgMTa4toHMdSVzfzpFw-SJuZWBa0C7LP_grm4EMF_ArZlybCnR7B2uRMy2Q2pjBhy8tuK7z5EoCA');
		expect(lish.id).toBe(FIXED_ID);
		expect(await ManifestAdmission.check(lish)).toEqual(VERIFIED);
	});

	it('reports an unsigned manifest as only that', async () => {
		expect(await ManifestAdmission.check(manifest())).toEqual(UNSIGNED);
	});

	it('fails the signature for any change of signed content that keeps a valid structure', async () => {
		const lish = await sign(manifest());
		for (const change of [{ name: 'Other' }, { created: '2026-10-08T10:00:01.000Z' }, { files: [{ path: 'b.txt', size: 5, checksums: ['aa', 'bb'] }] }, { files: [{ path: 'a.txt', size: 5, checksums: ['aa', 'bc'] }] }]) {
			expect(await ManifestAdmission.check({ ...lish, ...change } as ILISH)).toEqual({ signed: true, signatureValid: false, idMatchesPublisher: true });
		}
	});

	it('fails only the ID for a valid signature under an ID the signing key does not derive', async () => {
		expect(await ManifestAdmission.check(await takenID())).toEqual({ signed: true, signatureValid: true, idMatchesPublisher: false });
		// A random ID under a signature fails the same way.
		expect(await ManifestAdmission.check(await signKeepingID(manifest(), await fixedKey()))).toEqual({ signed: true, signatureValid: true, idMatchesPublisher: false });
	});

	it('judges the signature and the ID each on its own', async () => {
		// Signed by one key, naming another: neither the signature nor the ID is that publisher's.
		const other = await generateKeyPair('Ed25519');
		const both = { ...(await sign(manifest(), other)), publisher: PUBLISHER };
		expect(await ManifestAdmission.check(both)).toEqual({ signed: true, signatureValid: false, idMatchesPublisher: false });
	});

	it('fails the signature of a publisher whose key is not Ed25519', async () => {
		const rsa = await generateKeyPair('RSA', 1024);
		const lish = { ...(await sign(manifest())), publisher: peerIdFromPrivateKey(rsa).toString() };
		expect((await ManifestAdmission.check(lish)).signatureValid).toBe(false);
	});

	it('refuses a signed manifest whose shape is broken, whatever its signature', async () => {
		const lish = await sign(manifest());
		for (const broken of [{ signature: undefined }, { nonce: undefined }]) {
			await expect(ManifestAdmission.check({ ...lish, ...broken } as unknown as ILISH)).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_MANIFEST });
		}
		// The base32 CID form parses to the same Peer ID; the shape check in shared refuses it.
		const key = await fixedKey();
		const withCid = { ...manifest(), publisher: peerIdFromPrivateKey(key).toCID().toString(base32), nonce: TEST_NONCE };
		await expect(ManifestAdmission.check({ ...withCid, signature: encodeSignature(await key.sign(signedManifestBytes(withCid))) })).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_MANIFEST });
	});
});

describe('ManifestAdmission.requireUnattended', () => {
	it('passes an unsigned and a verified manifest and returns the publisher', async () => {
		expect(await ManifestAdmission.requireUnattended(manifest())).toBeNull();
		expect(await ManifestAdmission.requireUnattended(await sign(manifest()))).toBe(PUBLISHER);
	});

	it('refuses a signed manifest that fails a check, with the check as the code', async () => {
		await expect(ManifestAdmission.requireUnattended(await changed())).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_SIGNATURE, detail: 'signature does not match the manifest' });
		await expect(ManifestAdmission.requireUnattended(await takenID())).rejects.toMatchObject({ code: ErrorCodes.LISH_ID_MISMATCH });
	});

	it('refuses a CID spelling that passes the shape check, as not canonical', async () => {
		// For the all-zero seed the base32 CID happens to use only base58 letters ("bafz…"): it passes
		// the shape check and verifies cryptographically; only the canonical comparison refuses it.
		const key = await generateKeyPairFromSeed('Ed25519', new Uint8Array(32));
		const cid = peerIdFromPrivateKey(key).toCID().toString(base32);
		expect(cid).toBe('bafzaajaiaejcao3ke66m5nvefvrkhkgqfjxq243fgikxohpciotdvqciugfvtwrj');
		const withCid = { ...manifest(), publisher: cid, nonce: TEST_NONCE };
		const lish = { ...withCid, signature: encodeSignature(await key.sign(signedManifestBytes(withCid))) };
		await expect(ManifestAdmission.requireUnattended(lish)).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_SIGNATURE, detail: 'publisher is not in canonical form' });
	});

	it('refuses another publisher than the expected one', async () => {
		const signed = await sign(manifest());
		const mismatch = { code: ErrorCodes.LISH_PUBLISHER_MISMATCH };
		expect(await ManifestAdmission.requireUnattended(signed, PUBLISHER)).toBe(PUBLISHER);
		await expect(ManifestAdmission.requireUnattended(signed, 'Q')).rejects.toMatchObject(mismatch);
		await expect(ManifestAdmission.requireUnattended(signed, null)).rejects.toMatchObject(mismatch);
		await expect(ManifestAdmission.requireUnattended(manifest(), PUBLISHER)).rejects.toMatchObject(mismatch);
		expect(await ManifestAdmission.requireUnattended(manifest(), null)).toBeNull();
	});
});

describe('ManifestAdmission.assertExpected', () => {
	it('compares the publisher a manifest names, verified or not', async () => {
		const mismatch = expect.objectContaining({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH });
		// The check that follows decides whether the name holds; here only the name counts.
		const named = await changed();
		expect(() => ManifestAdmission.assertExpected(named, PUBLISHER)).not.toThrow();
		expect(() => ManifestAdmission.assertExpected(named, undefined)).not.toThrow();
		expect(() => ManifestAdmission.assertExpected(named, 'Q')).toThrow(mismatch);
		expect(() => ManifestAdmission.assertExpected(named, null)).toThrow(mismatch);
		expect(() => ManifestAdmission.assertExpected(manifest(), PUBLISHER)).toThrow(mismatch);
		expect(() => ManifestAdmission.assertExpected(manifest(), null)).not.toThrow();
	});
});

describe('ManifestAdmission.gate', () => {
	it('passes a verified manifest without asking', async () => {
		expect(await ManifestAdmission.gate(await sign(manifest()), false)).toEqual(VERIFIED);
	});

	it('refuses an unverified manifest with its first failed check, and the checks in the detail', async () => {
		const unsigned = await ManifestAdmission.gate(manifest(), false).catch(error => error);
		expect(unverifiedLISHFromError(unsigned)).toEqual({ code: 'LISH_UNSIGNED', checks: UNSIGNED });
		const forged = await ManifestAdmission.gate(await changed(), false).catch(error => error);
		expect(unverifiedLISHFromError(forged)).toEqual({ code: 'LISH_INVALID_SIGNATURE', checks: { signed: true, signatureValid: false, idMatchesPublisher: true }, publisher: PUBLISHER });
		const taken = await ManifestAdmission.gate(await takenID(), false).catch(error => error);
		expect(unverifiedLISHFromError(taken)).toMatchObject({ code: 'LISH_ID_MISMATCH', checks: { signed: true, signatureValid: true, idMatchesPublisher: false } });
		// Both failed: the signature is reported, the ID check still shows in the detail.
		const both = await ManifestAdmission.gate({ ...(await changed()), id: 'a0000000-0000-4000-8000-000000000001' }, false).catch(error => error);
		expect(unverifiedLISHFromError(both)).toMatchObject({ code: 'LISH_INVALID_SIGNATURE', checks: { signed: true, signatureValid: false, idMatchesPublisher: false } });
	});

	it('passes an unverified manifest the user agreed to, and still reports what it found', async () => {
		expect(await ManifestAdmission.gate(manifest(), true)).toEqual(UNSIGNED);
		expect(await ManifestAdmission.gate(await changed(), true)).toEqual({ signed: true, signatureValid: false, idMatchesPublisher: true });
	});

	it('never lets the agreement cover a broken shape', async () => {
		const lish = await sign(manifest());
		await expect(ManifestAdmission.gate({ ...lish, signature: undefined } as unknown as ILISH, true)).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_MANIFEST });
	});
});

describe('a manifest waiting for the answer', () => {
	/** An admission whose `resume` counts its runs and returns the checks it was given. */
	function waiting() {
		const admission = new ManifestAdmission<unknown>();
		const runs: unknown[] = [];
		const admit = (lish: ILISH, accepted = false) =>
			admission.admit(lish, accepted, async checks => {
				runs.push(checks);
				return checks;
			});
		const tokenOf = async (lish: ILISH) => unverifiedLISHFromError(await admit(lish).catch(error => error))!.token!;
		return { admission, runs, admit, tokenOf };
	}
	const direct = (resume: () => Promise<unknown>) => resume();

	it('adds a verified manifest at once', async () => {
		const { runs, admit } = waiting();
		expect(await admit(await sign(manifest()))).toEqual(VERIFIED);
		expect(runs).toHaveLength(1);
	});

	it('adds nothing until the user agrees, then exactly the manifest it was asked about', async () => {
		const { admission, runs, tokenOf } = waiting();
		const token = await tokenOf(manifest());
		expect(runs).toHaveLength(0);
		expect(await admission.answer(token, true, direct)).toEqual(UNSIGNED);
		expect(runs).toEqual([UNSIGNED]);
		// One answer per question.
		await expect(admission.answer(token, true, direct)).rejects.toMatchObject({ code: ErrorCodes.LISH_CONFIRMATION_EXPIRED });
		expect(runs).toHaveLength(1);
	});

	it('lets the manifest go on a refusal', async () => {
		const { admission, runs, tokenOf } = waiting();
		const token = await tokenOf(manifest());
		expect(await admission.answer(token, false, direct)).toBeNull();
		await expect(admission.answer(token, true, direct)).rejects.toMatchObject({ code: ErrorCodes.LISH_CONFIRMATION_EXPIRED });
		expect(runs).toHaveLength(0);
	});

	it('runs the adding inside what the caller wraps it in', async () => {
		const { admission, tokenOf } = waiting();
		const token = await tokenOf(manifest());
		const order: string[] = [];
		await admission.answer(token, true, async resume => {
			order.push('enter');
			const result = await resume();
			order.push('leave');
			return result;
		});
		expect(order).toEqual(['enter', 'leave']);
	});

	it('keeps one question per ID: asking again replaces the earlier one', async () => {
		const { admission, runs, tokenOf } = waiting();
		const first = await tokenOf(manifest());
		const second = await tokenOf(await changed().then(lish => ({ ...lish, id: manifest().id })));
		await expect(admission.answer(first, true, direct)).rejects.toMatchObject({ code: ErrorCodes.LISH_CONFIRMATION_EXPIRED });
		expect((await admission.answer(second, true, direct)) as { signed: boolean }).toMatchObject({ signed: true, signatureValid: false });
		expect(runs).toHaveLength(1);
	});

	it('drops the question once the same ID is added another way', async () => {
		const { admission, admit, tokenOf } = waiting();
		const token = await tokenOf({ ...(await changed()) });
		// A verified manifest for the same ID arrives, e.g. from the next peer.
		await admit(await sign(manifest()));
		await expect(admission.answer(token, true, direct)).rejects.toMatchObject({ code: ErrorCodes.LISH_CONFIRMATION_EXPIRED });
	});

	it('adds at once when the user agreed beforehand', async () => {
		const { runs, admit } = waiting();
		expect(await admit(manifest(), true)).toEqual(UNSIGNED);
		expect(runs).toHaveLength(1);
	});

	describe('within its limits', () => {
		/** An admission with the given limits; `tokenOf` asks about a manifest of `checksums` chunks under `id`. */
		function limited(limits: { count?: number; bytes?: number; ttlMs?: number }) {
			const admission = new ManifestAdmission<string>({ ttlMs: 60_000, count: 100, bytes: 1 << 30, ...limits });
			const tokenOf = async (id: string, checksums = 1, extra: Record<string, unknown> = {}) => {
				const lish = manifest({ id, files: [{ path: 'a.txt', size: 4 * checksums, checksums: Array.from({ length: checksums }, () => 'c'.repeat(64)) }], ...extra });
				return unverifiedLISHFromError(await admission.admit(lish, false, async () => id).catch(error => error))!.token!;
			};
			const stillHeld = async (token: string) =>
				admission
					.answer(token, true, resume => resume())
					.then(
						() => true,
						() => false
					);
			return { tokenOf, stillHeld };
		}

		it('lets the oldest question go when too many wait', async () => {
			const { tokenOf, stillHeld } = limited({ count: 2 });
			const [first, second, third] = [await tokenOf('one'), await tokenOf('two'), await tokenOf('three')];
			expect(await stillHeld(first)).toBe(false);
			expect(await stillHeld(second)).toBe(true);
			expect(await stillHeld(third)).toBe(true);
		});

		it('lets the oldest questions go when the waiting manifests grow too large', async () => {
			// 1000 checksums of 64 characters weigh about 80 kB; two of them do not fit under 100 kB.
			const { tokenOf, stillHeld } = limited({ bytes: 100_000 });
			const small = await tokenOf('small');
			const large = await tokenOf('large', 1000);
			expect(await stillHeld(small)).toBe(true);
			const second = await tokenOf('second', 1000);
			expect(await stillHeld(large)).toBe(false);
			expect(await stillHeld(second)).toBe(true);
		});

		it('counts directories and links too, so a manifest made only of them is not held for free', async () => {
			const { tokenOf, stillHeld } = limited({ bytes: 100_000 });
			const entries = Array.from({ length: 1000 }, (_, i) => `${'d'.repeat(60)}${i}`);
			const directories = await tokenOf('directories', 1, { directories: entries.map(path => ({ path })) });
			const links = await tokenOf('links', 1, { links: entries.map(path => ({ path, target: path })) });
			expect(await stillHeld(directories)).toBe(false);
			expect(await stillHeld(links)).toBe(true);
		});

		it('counts the description and every entry, however short its path', async () => {
			const { tokenOf, stillHeld } = limited({ bytes: 100_000 });
			const first = await tokenOf('first', 1, { description: 'x'.repeat(60_000) });
			const second = await tokenOf('second', 1, { description: 'x'.repeat(60_000) });
			expect(await stillHeld(first)).toBe(false);
			expect(await stillHeld(second)).toBe(true);
			// Directories named with one letter: next to nothing in paths, yet thousands of entries.
			const short = await tokenOf('short', 1, { directories: Array.from({ length: 3000 }, () => ({ path: 'd' })) });
			const next = await tokenOf('next');
			expect(await stillHeld(short)).toBe(false);
			expect(await stillHeld(next)).toBe(true);
		});

		it('counts whatever a manifest carries, expected or not', async () => {
			const long = 'x'.repeat(60_000);
			const file = { path: 'a.txt', size: 8 };
			// A timestamp far too long, a field nobody defined, and checksums of uneven length.
			for (const extra of [{ created: long }, { unknown: long }, { files: [{ ...file, checksums: ['aa'], modified: long }] }, { files: [{ ...file, checksums: ['aa', long] }] }]) {
				const { tokenOf, stillHeld } = limited({ bytes: 100_000 });
				const first = await tokenOf('first', 1, extra);
				const second = await tokenOf('second', 1, extra);
				expect(await stillHeld(first)).toBe(false);
				expect(await stillHeld(second)).toBe(true);
			}
		});

		it('still holds one manifest larger than the whole allowance, so the user can answer about it', async () => {
			const { tokenOf, stillHeld } = limited({ bytes: 100_000 });
			const earlier = await tokenOf('earlier');
			const huge = await tokenOf('huge', 5000);
			expect(await stillHeld(earlier)).toBe(false);
			expect(await stillHeld(huge)).toBe(true);
		});

		it('lets a question go when nobody answers in time', async () => {
			const { tokenOf, stillHeld } = limited({ ttlMs: 20 });
			const token = await tokenOf('slow');
			await Bun.sleep(60);
			expect(await stillHeld(token)).toBe(false);
		});
	});

	it('forgets every question on clear', async () => {
		const { admission, tokenOf } = waiting();
		const token = await tokenOf(manifest());
		admission.clear();
		await expect(admission.answer(token, true, direct)).rejects.toMatchObject({ code: ErrorCodes.LISH_CONFIRMATION_EXPIRED });
	});
});

describe('ManifestAdmission.storable', () => {
	it('keeps a verified and an unsigned manifest as they are', async () => {
		const signed = await sign(manifest());
		expect(ManifestAdmission.storable(signed, VERIFIED)).toBe(signed);
		const unsigned = manifest();
		expect(ManifestAdmission.storable(unsigned, UNSIGNED)).toBe(unsigned);
	});

	it('keeps a manifest that failed a check as an unsigned body', async () => {
		const forged = await changed();
		const stored = ManifestAdmission.storable(forged, await ManifestAdmission.check(forged));
		expect(stored).toEqual({ ...manifest(), id: FIXED_ID, name: 'Other' });
		expect(await ManifestAdmission.check(stored)).toEqual(UNSIGNED);
	});
});

describe('deriveLISHID', () => {
	it('matches a fixed vector and has the form of a version 8 UUID', () => {
		const id = deriveLISHID(PUBLISHER, TEST_NONCE);
		expect(id).toBe(FIXED_ID);
		expect(isDerivedLISHID(id)).toBe(true);
		expect(isDerivedLISHID('a0000000-0000-4000-8000-000000000001')).toBe(false);
	});

	it('changes with the publisher and with the nonce', () => {
		expect(deriveLISHID(PUBLISHER, 'B' + TEST_NONCE.slice(1))).not.toBe(FIXED_ID);
		expect(deriveLISHID('12D3KooWAcB6uoHuAPyfsYcwnYTqGNt2biPmSmvbBam9cwmawgzK', TEST_NONCE)).not.toBe(FIXED_ID);
	});

	it('matches only the publisher and nonce it was made from', () => {
		expect(lishIDMatchesPublisher({ id: FIXED_ID, publisher: PUBLISHER, nonce: TEST_NONCE })).toBe(true);
		expect(lishIDMatchesPublisher({ id: FIXED_ID, publisher: '12D3KooWAcB6uoHuAPyfsYcwnYTqGNt2biPmSmvbBam9cwmawgzK', nonce: TEST_NONCE })).toBe(false);
		expect(lishIDMatchesPublisher({ id: FIXED_ID, publisher: PUBLISHER, nonce: 'B' + TEST_NONCE.slice(1) })).toBe(false);
		expect(lishIDMatchesPublisher({ id: FIXED_ID, publisher: PUBLISHER })).toBe(false);
		// One changed bit of the ID is enough.
		expect(lishIDMatchesPublisher({ id: FIXED_ID.slice(0, -1) + 'b', publisher: PUBLISHER, nonce: TEST_NONCE })).toBe(false);
	});
});
