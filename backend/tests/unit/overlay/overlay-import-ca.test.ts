import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { OverlayAccess } from '../../../src/overlay/overlay-access.ts';
import { OverlayStore } from '../../../src/overlay/overlay-store.ts';

const NET = 'net-ca';
/** This device's own membership: the restore below concerns the CA key, not joining. */
const MEMBER_CERT = { name: 'self', networks: ['100.64.0.9/16'], notAfter: '2099-01-01T00:00:00Z', fingerprint: '9'.repeat(64) };
const pem = (raw: Uint8Array): string => `-----BEGIN NEBULA ED25519 PRIVATE KEY-----\n${Buffer.from(raw).toString('base64')}\n-----END NEBULA ED25519 PRIVATE KEY-----\n`;

/** Restoring a lishnet's CA key makes this node a founder, so the key must really be the CA's — not only end in its public key. */
describe('importing a CA key', () => {
	it('accepts the CA key and refuses one that only carries its public half', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'overlay-ca-'));
		try {
			const ca = await generateKeyPair('Ed25519');
			const other = await generateKeyPair('Ed25519');
			const access = new OverlayAccess({
				nodes: { store: (id: string) => new OverlayStore(dir, id), caPublicKey: async () => Buffer.from(ca.publicKey.raw).toString('hex'), ownCertificate: async () => MEMBER_CERT, currentState: async () => null } as any,
				getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
				addNetwork: async () => {},
				refresh: async () => {},
				emit: () => {},
			});
			// Another key's seed with the CA's public key appended: the old check compared the appended half only.
			const forged = new Uint8Array(64);
			forged.set(other.raw.subarray(0, 32), 0);
			forged.set(ca.publicKey.raw, 32);
			await expect(access.importCA(NET, pem(forged))).rejects.toThrow('does not belong');
			expect(new OverlayStore(dir, NET).has('ca.key')).toBe(false);
			await access.importCA(NET, pem(ca.raw));
			expect(new OverlayStore(dir, NET).has('ca.key')).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	/** A CA restored on another device handed out the founder's own address: it knew none of the members. */
	for (const withList of [true, false])
		it(`a node restored from ${withList ? 'a backup' : 'the key alone'} gives a new member a free address`, async () => {
			const dirA = await mkdtemp(join(tmpdir(), 'overlay-ca-a-'));
			const dirB = await mkdtemp(join(tmpdir(), 'overlay-ca-b-'));
			const issue = spyOn(OverlayAccess.prototype as any, 'issueCertificate').mockImplementation(async (..._args: unknown[]) => ({ cert: 'crt', fingerprint: 'f'.repeat(64), notAfter: '2099-01-01T00:00:00Z' }));
			try {
				const ca = await generateKeyPair('Ed25519');
				const make = (dir: string): OverlayAccess =>
					new OverlayAccess({
						nodes: { store: (id: string) => new OverlayStore(dir, id), caPublicKey: async () => Buffer.from(ca.publicKey.raw).toString('hex'), ownCertificate: async () => MEMBER_CERT, currentState: async () => null } as any,
						getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
						addNetwork: async () => {},
						refresh: async () => {},
						emit: () => {},
					});
				const member = (n: number, founder = false) => ({ name: `m${n}`, ...(founder ? { founder: true } : {}), peerID: `peer-${n}`, vpnIP: `100.64.0.${n}`, roles: [], notAfter: '2099-01-01T00:00:00Z', fingerprint: String(n).repeat(64).slice(0, 64), issued: '2026-01-01T00:00:00Z', revoked: false });
				const a = new OverlayStore(dirA, NET);
				await a.ensureDir();
				await a.writeText('ca.key', pem(ca.raw));
				await a.writeJSON('founder.json', { nextHost: 3, members: [member(1, true), member(2)], requests: [] });
				const backup = withList ? (await make(dirA).exportCA(NET)).caKey : pem(ca.raw);
				const b = make(dirB);
				await b.importCA(NET, backup);
				expect(await new OverlayStore(dirB, NET).readText('ca.key')).toBe(pem(ca.raw));
				const request = { type: 'lish-overlay-request', networkID: NET, name: 'new', peerID: '1'.repeat(46), publicKey: '-----BEGIN NEBULA X25519 PUBLIC KEY-----\nx\n-----END NEBULA X25519 PUBLIC KEY-----', created: '2026-01-01T00:00:00Z' };
				await b.issue(request);
				const members = await b.listMembers(NET);
				expect(members.find(m => m.name === 'new')?.vpnIP).toBe(withList ? '100.64.0.3' : '100.64.0.2');
				if (withList) expect(members.map(m => m.name)).toEqual(['m1', 'm2', 'new']);
			} finally {
				issue.mockRestore();
				await rm(dirA, { recursive: true, force: true });
				await rm(dirB, { recursive: true, force: true });
			}
		});

	/** A founder restored on a clean device could approve others but had no certificate, and no screen to get one. */
	// The device may also hold a certificate it can no longer use: one that expired, or one revoked meanwhile.
	const unusable: Array<[string, unknown, string[]]> = [
		['without a certificate', null, []],
		['with an expired certificate', { ...MEMBER_CERT, notAfter: '2020-01-01T00:00:00Z' }, []],
		['with a revoked certificate', MEMBER_CERT, [MEMBER_CERT.fingerprint]],
	];
	for (const [what, own, revoked] of unusable)
		it(`a founder restored on a device ${what} signs its own membership and imports it`, async () => {
			await restoredFounderSignsItself(own, revoked);
		});

	async function restoredFounderSignsItself(own: unknown, revoked: string[]): Promise<void> {
		const dir = await mkdtemp(join(tmpdir(), 'overlay-ca-'));
		const request = { type: 'lish-overlay-request', networkID: NET, name: 'Network', peerID: '1'.repeat(46), publicKey: 'pub', created: '2026-01-01T00:00:00Z' };
		const bundle = { type: 'lish-overlay-certificate', networkID: NET, certificate: 'crt' };
		const calls: unknown[][] = [];
		const ask = spyOn(OverlayAccess.prototype, 'requestAccess').mockImplementation(async (...args: unknown[]) => (calls.push(['request', ...args]), request) as any);
		const sign = spyOn(OverlayAccess.prototype, 'issue').mockImplementation(async (...args: unknown[]) => (calls.push(['issue', ...args]), bundle) as any);
		const take = spyOn(OverlayAccess.prototype, 'importCertificate').mockImplementation(async (...args: unknown[]) => (calls.push(['import', ...args]), {}) as any);
		try {
			const ca = await generateKeyPair('Ed25519');
			const access = new OverlayAccess({
				nodes: { store: (id: string) => new OverlayStore(dir, id), caPublicKey: async () => Buffer.from(ca.publicKey.raw).toString('hex'), ownCertificate: async () => own, currentState: async () => ({ revoked }) } as any,
				getRow: () => ({ networkID: NET, name: 'Network', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
				addNetwork: async () => {},
				refresh: async () => {},
				emit: () => {},
			});
			await access.importCA(NET, pem(ca.raw));
			expect(calls).toEqual([
				['request', NET, 'Network'],
				['issue', request],
				['import', bundle],
			]);
		} finally {
			ask.mockRestore();
			sign.mockRestore();
			take.mockRestore();
			await rm(dir, { recursive: true, force: true });
		}
	}

	/**
	 * A revocation made on another device holding the key reached this one in the signed state only, not in its
	 * member list; a backup of the list alone lost it, and the restored founder's next state unblocked the member.
	 */
	it('a backup keeps the revocations this device knows from the signed state only', async () => {
		const dirA = await mkdtemp(join(tmpdir(), 'overlay-ca-a-'));
		const dirB = await mkdtemp(join(tmpdir(), 'overlay-ca-b-'));
		const elsewhere = 'c'.repeat(64);
		try {
			const ca = await generateKeyPair('Ed25519');
			const published: string[][] = [];
			const make = (dir: string, state: unknown): OverlayAccess =>
				new OverlayAccess({
					nodes: {
						store: (id: string) => new OverlayStore(dir, id),
						caPublicKey: async () => Buffer.from(ca.publicKey.raw).toString('hex'),
						ownCertificate: async () => MEMBER_CERT,
						currentState: async () => state,
						publishNewState: async (_id: string, change: { revoked: string[] }) => void published.push(change.revoked),
					} as any,
					getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
					addNetwork: async () => {},
					refresh: async () => {},
					emit: () => {},
				});
			const a = new OverlayStore(dirA, NET);
			await a.ensureDir();
			await a.writeText('ca.key', pem(ca.raw));
			await a.writeJSON('founder.json', { nextHost: 2, members: [], requests: [] });
			const backup = (await make(dirA, { revoked: [elsewhere] }).exportCA(NET)).caKey;
			// Restored where no signed state ever arrived.
			const b = make(dirB, null);
			await b.importCA(NET, backup);
			await b.setHosts(NET, [], []);
			expect(published).toEqual([[elsewhere]]);
		} finally {
			await rm(dirA, { recursive: true, force: true });
			await rm(dirB, { recursive: true, force: true });
		}
	});

	it('refuses a backup whose member list is damaged', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'overlay-ca-'));
		try {
			const ca = await generateKeyPair('Ed25519');
			const access = new OverlayAccess({
				nodes: { store: (id: string) => new OverlayStore(dir, id), caPublicKey: async () => Buffer.from(ca.publicKey.raw).toString('hex') } as any,
				getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
				addNetwork: async () => {},
				refresh: async () => {},
				emit: () => {},
			});
			const list = Buffer.from(JSON.stringify({ nextHost: 2, members: [{ vpnIP: '198.51.100.9' }] })).toString('base64');
			await expect(access.importCA(NET, `${pem(ca.raw)}-----BEGIN LISH OVERLAY MEMBERS-----\n${list}\n-----END LISH OVERLAY MEMBERS-----\n`)).rejects.toThrow('damaged');
			expect(new OverlayStore(dir, NET).has('ca.key')).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
