import { describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJSON, decodeSignature, encodeSignature, ErrorCodes, LISH_SIGNATURE_DOMAIN, signedManifestBytes, signedManifestPayload, validateLISHStructure, type ILISH } from '@shared';
import { createLISH, getPermissions } from '../../../src/lish/lish.ts';

const PUBLISHER = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
const SIGNATURE = 'A'.repeat(86);

function signed(overrides: Record<string, unknown> = {}): ILISH {
	return {
		id: '5f0c6d2e-0000-4000-8000-000000000001',
		publisher: PUBLISHER,
		signature: SIGNATURE,
		name: 'Demo',
		created: '2026-10-08T10:00:00.000Z',
		chunkSize: 4,
		checksumAlgo: 'sha256',
		directories: [{ path: 'docs', permissions: '755' }],
		files: [{ path: 'docs/a.txt', size: 5, permissions: '644', modified: '2026-10-08T09:00:00Z', checksums: ['aa', 'bb'] }],
		links: [{ path: 'docs/l', target: 'docs/a.txt' }],
		...overrides,
	} as ILISH;
}

describe('signed manifest bytes', () => {
	it('match a fixed vector', () => {
		const text = new TextDecoder().decode(signedManifestBytes(signed()));
		expect(text).toBe(LISH_SIGNATURE_DOMAIN + '{"checksumAlgo":"sha256","chunkSize":4,"created":"2026-10-08T10:00:00.000Z","directories":[{"path":"docs","permissions":"755"}],"files":[{"checksums":["aa","bb"],"modified":"2026-10-08T09:00:00Z","path":"docs/a.txt","permissions":"644","size":5}],"id":"5f0c6d2e-0000-4000-8000-000000000001","links":[{"hardlink":false,"path":"docs/l","target":"docs/a.txt"}],"name":"Demo","publisher":"12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo"}');
	});

	it('ignore key order, the signature itself and node-local fields', () => {
		const base = signedManifestBytes(signed());
		const reordered = JSON.parse(JSON.stringify(signed()), (_key, value) => (value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value));
		expect(signedManifestBytes(reordered)).toEqual(base);
		expect(signedManifestBytes(signed({ signature: 'B'.repeat(86) }))).toEqual(base);
		expect(signedManifestBytes({ ...signed(), directory: '/tmp/x', finalDirectory: '/tmp/y', chunks: ['aa'] } as ILISH)).toEqual(base);
	});

	it('normalize what the database rebuilds differently', () => {
		const stored = signed({ directories: undefined, links: undefined, files: [{ path: 'docs/a.txt', size: 5, permissions: '644', modified: '2026-10-08T09:00:00Z', checksums: ['aa', 'bb'] }], description: undefined });
		const explicit = signed({ directories: [], links: [], description: '' });
		expect(signedManifestBytes(stored)).toEqual(signedManifestBytes(explicit));
		const hardlinkFalse = signed({ links: [{ path: 'docs/l', target: 'docs/a.txt', hardlink: false }] });
		expect(signedManifestBytes(hardlinkFalse)).toEqual(signedManifestBytes(signed()));
	});

	it('change with any signed content', () => {
		const base = signedManifestBytes(signed());
		for (const change of [{ name: 'Other' }, { created: '2026-10-08T10:00:01.000Z' }, { publisher: '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xp' }, { files: [{ path: 'docs/a.txt', size: 5, checksums: ['aa', 'bc'] }] }]) {
			expect(signedManifestBytes(signed(change))).not.toEqual(base);
		}
	});

	it('keep item order', () => {
		const two = signed({
			files: [
				{ path: 'b', size: 1, checksums: ['aa'] },
				{ path: 'a', size: 1, checksums: ['bb'] },
			],
			directories: [],
			links: [],
		});
		const swapped = signed({
			files: [
				{ path: 'a', size: 1, checksums: ['bb'] },
				{ path: 'b', size: 1, checksums: ['aa'] },
			],
			directories: [],
			links: [],
		});
		expect(signedManifestPayload(two)['files']).not.toEqual(signedManifestPayload(swapped)['files']);
	});
});

describe('canonical JSON', () => {
	it('sorts keys by UTF-16 code units and escapes like JSON', () => {
		expect(canonicalJSON({ b: 1, a: [true, 'x\n"'], é: 0, Z: 2 })).toBe('{"Z":2,"a":[true,"x\\n\\""],"b":1,"é":0}');
		expect(canonicalJSON({ '😀': 1, דּ: 2 })).toBe('{"😀":1,"דּ":2}');
	});
	it('refuses values outside the manifest domain', () => {
		expect(() => canonicalJSON(1.5)).toThrow();
		expect(() => canonicalJSON(new Date())).toThrow();
	});
});

describe('signed manifest shape', () => {
	const reject = (lish: unknown) => expect(() => validateLISHStructure(lish as ILISH, 1 << 30)).toThrow(expect.objectContaining({ code: ErrorCodes.LISH_INVALID_MANIFEST }));

	it('accepts the canonical shape', () => {
		expect(() => validateLISHStructure(signed(), 1 << 30)).not.toThrow();
	});

	it('rejects fields the database would drop', () => {
		reject({ ...signed(), extra: 'x' });
		reject(signed({ files: [{ path: 'docs/a.txt', size: 5, checksums: ['aa', 'bb'], extra: 1 } as never] }));
	});

	it('rejects values that do not survive storage', () => {
		reject(signed({ links: [{ path: 'docs/l', target: 'docs/a.txt', hardlink: 1 as never }] }));
		reject(signed({ files: [{ path: 'docs/a.txt', size: 5, modified: '123', checksums: ['aa', 'bb'] }] }));
		reject({ ...signed(), name: null });
		reject({ ...signed(), created: new Date() });
		reject(signed({ files: [{ path: 'docs/a.txt', size: 5, permissions: '9', checksums: ['aa', 'bb'] }] }));
	});

	it('requires both signature fields in their wire form', () => {
		reject({ ...signed(), signature: undefined });
		reject({ ...signed(), publisher: undefined });
		reject(signed({ publisher: 'not a peer id!' }));
		reject(signed({ signature: 'short' }));
	});

	it('accepts permissions the creator writes without leading zeros', () => {
		for (const permissions of ['0', '4', '44', '644']) expect(() => validateLISHStructure(signed({ directories: [{ path: 'docs', permissions }] }), 1 << 30)).not.toThrow();
		expect(getPermissions(0o044)).toBe('44');
	});

	it('leaves unsigned manifests on the old lenient rules', () => {
		const unsigned = { ...signed(), publisher: undefined, signature: undefined, files: [{ path: 'docs/a.txt', size: 5, modified: '123', checksums: ['aa', 'bb'] }] };
		expect(() => validateLISHStructure(unsigned as unknown as ILISH, 1 << 30)).not.toThrow();
	});

	it('accepts what createLISH produces once signed', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'lish-sig-'));
		try {
			await writeFile(join(dir, 'a.txt'), 'hello');
			await chmod(join(dir, 'a.txt'), 0o400);
			const lish = await createLISH(dir, 'x', 4, 'sha256', 1);
			expect(() => validateLISHStructure({ ...lish, publisher: PUBLISHER, signature: SIGNATURE }, 1 << 30)).not.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('signature encoding', () => {
	it('round-trips 64 bytes as unpadded base64url', () => {
		const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff);
		const text = encodeSignature(bytes);
		expect(text).toMatch(/^[A-Za-z0-9_-]{86}$/);
		expect(decodeSignature(text)).toEqual(bytes);
	});
});
