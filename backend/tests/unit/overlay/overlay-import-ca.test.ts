import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { OverlayAccess } from '../../../src/overlay/overlay-access.ts';
import { OverlayStore } from '../../../src/overlay/overlay-store.ts';

const NET = 'net-ca';
const pem = (raw: Uint8Array): string => `-----BEGIN NEBULA ED25519 PRIVATE KEY-----\n${Buffer.from(raw).toString('base64')}\n-----END NEBULA ED25519 PRIVATE KEY-----\n`;

/** Restoring a lishnet's CA key makes this node a founder, so the key must really be the CA's — not only end in its public key. */
describe('importing a CA key', () => {
	it('accepts the CA key and refuses one that only carries its public half', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'overlay-ca-'));
		try {
			const ca = await generateKeyPair('Ed25519');
			const other = await generateKeyPair('Ed25519');
			const access = new OverlayAccess({
				nodes: { store: (id: string) => new OverlayStore(dir, id), caPublicKey: async () => Buffer.from(ca.publicKey.raw).toString('hex') } as any,
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
						nodes: { store: (id: string) => new OverlayStore(dir, id), caPublicKey: async () => Buffer.from(ca.publicKey.raw).toString('hex'), ownCertificate: async () => null } as any,
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
