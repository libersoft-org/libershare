import { describe, expect, it } from 'bun:test';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { encodeSignature, ErrorCodes, signedManifestBytes, type ILISH, type IStoredLISH, type LISHid } from '@shared';
import { addLISH, getLISH } from '../../../src/db/lishs.ts';
import { withLISHOwnership } from '../../../src/lish/lish-ownership.ts';
import { verifyManifestSignature } from '../../../src/lish/manifest-signature.ts';
import { createTestDB } from '../helpers/fixtures.ts';

const ID = 'b0000000-0000-4000-8000-000000000002' as LISHid;
const CHECKSUM = 'a'.repeat(64);

function manifest(overrides: Record<string, unknown> = {}): ILISH {
	return { id: ID, name: 'Demo', created: '2026-10-08T10:00:00.000Z', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'a.txt', size: 4, checksums: [CHECKSUM] }], directories: [], links: [], ...overrides } as ILISH;
}

async function sign(lish: ILISH, key: typeof keyA): Promise<ILISH> {
	const withPublisher = { ...lish, publisher: peerIdFromPrivateKey(key).toString() };
	return { ...withPublisher, signature: encodeSignature(await key.sign(signedManifestBytes(withPublisher))) };
}

const keyA = await generateKeyPairFromSeed(
	'Ed25519',
	Uint8Array.from({ length: 32 }, (_, i) => i + 1)
);
const keyQ = await generateKeyPairFromSeed(
	'Ed25519',
	Uint8Array.from({ length: 32 }, (_, i) => 100 + i)
);
const A = peerIdFromPrivateKey(keyA).toString();

describe('addLISH keeps the stored publisher', () => {
	it('refuses another publisher or an unsigned body under a signed ID, leaving the row as it was', async () => {
		const db = createTestDB();
		const original = (await sign(manifest(), keyA)) as IStoredLISH;
		addLISH(db, original);
		for (const other of [(await sign(manifest({ name: 'Q' }), keyQ)) as IStoredLISH, manifest({ name: 'unsigned' }) as IStoredLISH]) {
			expect(() => addLISH(db, other)).toThrow(expect.objectContaining({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH }));
		}
		expect(getLISH(db, ID)).toMatchObject({ name: 'Demo', publisher: A, signature: original.signature });
	});

	it('refuses a signed body under an unsigned ID', async () => {
		const db = createTestDB();
		addLISH(db, manifest() as IStoredLISH);
		const signed = (await sign(manifest(), keyA)) as IStoredLISH;
		expect(() => addLISH(db, signed)).toThrow(expect.objectContaining({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH }));
		expect(getLISH(db, ID)?.publisher).toBeUndefined();
	});

	it('refuses an existing ID when the write requires a new one', () => {
		const db = createTestDB();
		addLISH(db, manifest() as IStoredLISH);
		expect(() => addLISH(db, manifest() as IStoredLISH, { requireNew: true })).toThrow(expect.objectContaining({ code: ErrorCodes.LISH_ALREADY_EXISTS }));
	});

	it('replaces every collection of a signed body, so the reloaded body still verifies', async () => {
		const { directories: _d, links: _l, ...withoutCollections } = manifest();
		for (const replacement of [withoutCollections, { ...withoutCollections, directories: [], links: [] }]) {
			const db = createTestDB();
			addLISH(db, (await sign(manifest({ directories: [{ path: 'old' }], links: [{ path: 'l', target: 'a.txt' }] }), keyA)) as IStoredLISH);
			addLISH(db, (await sign(replacement as ILISH, keyA)) as IStoredLISH);
			const stored = getLISH(db, ID)!;
			expect(stored.directories ?? []).toEqual([]);
			expect(stored.links ?? []).toEqual([]);
			// Rebuilt from the rows: stale directories or links would change the signed bytes.
			expect(await verifyManifestSignature(stored)).toEqual({ signed: true, publisher: A });
		}
	});
});

describe('withLISHOwnership', () => {
	it('serializes one ID and leaves other IDs free', async () => {
		const order: string[] = [];
		let release!: () => void;
		const first = withLISHOwnership('x', () => new Promise<void>(resolve => (release = resolve)).then(() => order.push('first')));
		const second = withLISHOwnership('x', () => order.push('second'));
		await withLISHOwnership('y', () => order.push('other'));
		expect(order).toEqual(['other']);
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(['other', 'first', 'second']);
	});

	it('an aborted wait ends at once, never runs its action, and leaves the lock usable', async () => {
		let release!: () => void;
		const owner = withLISHOwnership('z', () => new Promise<void>(resolve => (release = resolve)));
		const abort = new AbortController();
		let ran = false;
		const waiter = withLISHOwnership('z', () => (ran = true), abort.signal);
		abort.abort(new Error('destroyed'));
		// The waiter settles while the owner still holds the lock: no wait on the owner.
		await expect(waiter).rejects.toThrow('destroyed');
		release();
		await owner;
		expect(ran).toBe(false);
		expect(await withLISHOwnership('z', () => 'free')).toBe('free');
	});
});
