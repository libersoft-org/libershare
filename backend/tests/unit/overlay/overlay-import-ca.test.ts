import { describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
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
				nodes: { network: () => undefined, store: (id: string) => new OverlayStore(dir, id), caPublicKey: async () => Buffer.from(ca.publicKey.raw).toString('hex'), ownCertificate: async () => MEMBER_CERT, currentState: async () => null, knownRevocations: async () => ({ fingerprints: [], peers: {} }), reconfigure: async () => {}, sweepRevokedPeers: async () => {} } as any,
				getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
				addNetwork: async () => {},
				listOverlayIDs: () => [],
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

	// A member the backup revokes kept its open tunnel on a certificate the backup does not list for up to a minute.
	it('checks the open tunnels for revoked members once the backup is applied', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'overlay-ca-'));
		try {
			const ca = await generateKeyPair('Ed25519');
			const calls: string[] = [];
			const access = new OverlayAccess({
				nodes: { network: () => undefined, store: (id: string) => new OverlayStore(dir, id), caPublicKey: async () => Buffer.from(ca.publicKey.raw).toString('hex'), ownCertificate: async () => MEMBER_CERT, currentState: async () => null, knownRevocations: async () => ({ fingerprints: [], peers: {} }), reconfigure: async () => void calls.push('reconfigure'), sweepRevokedPeers: async () => void calls.push('sweep') } as any,
				getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
				addNetwork: async () => {},
				listOverlayIDs: () => [],
				refresh: async () => {},
				emit: () => {},
			});
			await access.importCA(NET, pem(ca.raw));
			expect(calls).toEqual(['reconfigure', 'sweep']);
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
						nodes: { network: () => undefined, store: (id: string) => new OverlayStore(dir, id), caPublicKey: async () => Buffer.from(ca.publicKey.raw).toString('hex'), ownCertificate: async () => MEMBER_CERT, currentState: async () => null, knownRevocations: async () => ({ fingerprints: [], peers: {} }), reconfigure: async () => {}, sweepRevokedPeers: async () => {} } as any,
						getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
						addNetwork: async () => {},
						listOverlayIDs: () => [],
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
				// Never the founder's .1 or this device's own address; with the list, never a listed member's either.
				const given = members.find(m => m.name === 'new')?.vpnIP;
				expect(given).toMatch(/^100\.64\.\d+\.\d+$/);
				expect([...(withList ? ['100.64.0.2'] : []), '100.64.0.1', '100.64.0.9']).not.toContain(given);
				if (withList) expect(members.map(m => m.name)).toEqual(['m1', 'm2', 'new']);
			} finally {
				issue.mockRestore();
				await rm(dirA, { recursive: true, force: true });
				await rm(dirB, { recursive: true, force: true });
			}
		});

	/** A founder restored on a clean device could approve others but had no certificate, and no screen to get one. */
	// The device may also hold a certificate it can no longer use: one that expired, or one revoked meanwhile.
	// The last case: revoked while the device was offline, known only from the backup being restored.
	const unusable: Array<[string, unknown, string[], string[]]> = [
		['without a certificate', null, [], []],
		['with an expired certificate', { ...MEMBER_CERT, notAfter: '2020-01-01T00:00:00Z' }, [], []],
		['with a revoked certificate', MEMBER_CERT, [MEMBER_CERT.fingerprint], []],
		['whose certificate the backup revokes', MEMBER_CERT, [], [MEMBER_CERT.fingerprint]],
	];
	for (const [what, own, revoked, backupRevoked] of unusable)
		it(`a founder restored on a device ${what} signs its own membership and imports it`, async () => {
			await restoredFounderSignsItself(own, revoked, backupRevoked);
		});

	async function restoredFounderSignsItself(own: unknown, revoked: string[], backupRevoked: string[]): Promise<void> {
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
				nodes: { network: () => undefined, store: (id: string) => new OverlayStore(dir, id), caPublicKey: async () => Buffer.from(ca.publicKey.raw).toString('hex'), ownCertificate: async () => own, currentState: async () => ({ revoked }), knownRevocations: async () => ({ fingerprints: revoked, peers: {} }), reconfigure: async () => {}, sweepRevokedPeers: async () => {} } as any,
				getRow: () => ({ networkID: NET, name: 'Network', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
				addNetwork: async () => {},
				listOverlayIDs: () => [],
				refresh: async () => {},
				emit: () => {},
			});
			const list = Buffer.from(JSON.stringify({ nextHost: 2, members: [], revoked: backupRevoked })).toString('base64');
			await access.importCA(NET, `${pem(ca.raw)}-----BEGIN LISH OVERLAY MEMBERS-----\n${list}\n-----END LISH OVERLAY MEMBERS-----\n`);
			expect(calls).toEqual([
				['request', NET, 'Network', undefined],
				['issue', request, {}],
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
						network: () => undefined,
						store: (id: string) => new OverlayStore(dir, id),
						caPublicKey: async () => Buffer.from(ca.publicKey.raw).toString('hex'),
						ownCertificate: async () => MEMBER_CERT,
						currentState: async () => state,
						knownRevocations: async () => ({ fingerprints: (state as any)?.revoked ?? [], peers: {} }),
						reconfigure: async () => {},
						sweepRevokedPeers: async () => {},
						publishNewState: async (_id: string, change: { revoked: string[] }) => void published.push(change.revoked),
					} as any,
					getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
					addNetwork: async () => {},
					listOverlayIDs: () => [],
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

	// A founder whose certificate ran out after the restore had no screen to renew it and stayed out of its lishnet.
	it("a founder renews its own membership before it ends, and only a founder's", async () => {
		const dir = await mkdtemp(join(tmpdir(), 'overlay-ca-'));
		let own: { notAfter: string; fingerprint: string } = { ...MEMBER_CERT, notAfter: new Date(Date.now() + 86_400_000).toISOString() };
		const renewed: unknown[] = [];
		const asked: unknown[][] = [];
		const signed: unknown[] = [];
		const ask = spyOn(OverlayAccess.prototype, 'requestAccess').mockImplementation((async (...args: unknown[]) => (asked.push(args), {})) as any);
		const sign = spyOn(OverlayAccess.prototype, 'issue').mockImplementation((async (_request: unknown, opts: unknown) => (signed.push(opts), {})) as any);
		const take = spyOn(OverlayAccess.prototype, 'importCertificate').mockImplementation((async (bundle: unknown) => (renewed.push(bundle), {})) as any);
		try {
			const ca = await generateKeyPair('Ed25519');
			const access = new OverlayAccess({
				nodes: { network: () => undefined, store: (id: string) => new OverlayStore(dir, id), caPublicKey: async () => Buffer.from(ca.publicKey.raw).toString('hex'), ownCertificate: async () => own, currentState: async () => null, knownRevocations: async () => ({ fingerprints: [], peers: {} }), reconfigure: async () => {}, sweepRevokedPeers: async () => {} } as any,
				getRow: () => ({ networkID: NET, name: 'Network', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
				addNetwork: async () => {},
				listOverlayIDs: () => [],
				refresh: async () => {},
				emit: () => {},
			});
			// The usual founder: its own node is the lighthouse and relay, and a renewal must keep it so.
			const hostRow = { networkID: NET, name: 'Network', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [{ vpnIP: '100.64.0.9', addr: '203.0.113.9:4242' }], relays: [{ vpnIP: '100.64.0.9', addr: '203.0.113.9:4242' }], lanDirect: false, version: 0 } };
			(access as any).deps.getRow = () => hostRow;
			// Not a founder yet: nothing to sign with.
			expect(await access.ensureOwnMembership(NET)).toBe(false);
			const store = new OverlayStore(dir, NET);
			await store.ensureDir();
			await store.writeText('ca.key', pem(ca.raw));
			// Ends tomorrow: renewed.
			expect(await access.ensureOwnMembership(NET)).toBe(true);
			own = { ...MEMBER_CERT, notAfter: new Date(Date.now() + 30 * 86_400_000).toISOString() };
			expect(await access.ensureOwnMembership(NET)).toBe(false);
			expect(renewed).toHaveLength(1);
			expect(asked).toEqual([[NET, 'Network', '203.0.113.9:4242']]);
			expect(signed).toEqual([{ roles: ['lighthouse', 'relay'] }]);
		} finally {
			ask.mockRestore();
			sign.mockRestore();
			take.mockRestore();
			await rm(dir, { recursive: true, force: true });
		}
	});

	/** The founder's two devices, each unaware of the other's approvals, both gave their next new member .2. */
	it('two devices holding the CA key give different members different addresses', async () => {
		const dirs = [await mkdtemp(join(tmpdir(), 'overlay-ca-a-')), await mkdtemp(join(tmpdir(), 'overlay-ca-b-'))];
		let serial = 0;
		const issue = spyOn(OverlayAccess.prototype as any, 'issueCertificate').mockImplementation(async (..._args: unknown[]) => ({ cert: 'crt', fingerprint: String(++serial).padStart(64, '0'), notAfter: '2099-01-01T00:00:00Z' }));
		try {
			const ca = await generateKeyPair('Ed25519');
			const make = (dir: string): OverlayAccess =>
				new OverlayAccess({
					nodes: { network: () => undefined, store: (id: string) => new OverlayStore(dir, id), caPublicKey: async () => Buffer.from(ca.publicKey.raw).toString('hex'), ownCertificate: async () => MEMBER_CERT, currentState: async () => null, knownRevocations: async () => ({ fingerprints: [], peers: {} }), reconfigure: async () => {}, sweepRevokedPeers: async () => {} } as any,
					getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
					addNetwork: async () => {},
					listOverlayIDs: () => [],
					refresh: async () => {},
					emit: () => {},
				});
			// Two peer IDs whose hashes pick the same slot of the whole subnet: without lanes they got one address.
			const slot = (id: string): number => createHash('sha256').update(id).digest().readUInt32BE(0) % (65536 - 3);
			const first = '1'.repeat(46);
			const base58 = (n: number): string => (n < 58 ? '' : base58(Math.floor(n / 58))) + '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[n % 58];
			let second = '';
			for (let i = 0; !second; i++) if (slot(`2${base58(i)}`.padEnd(46, '2')) === slot(first)) second = `2${base58(i)}`.padEnd(46, '2');
			const a = new OverlayStore(dirs[0]!, NET);
			await a.ensureDir();
			await a.writeText('ca.key', pem(ca.raw));
			await a.writeJSON('founder.json', { nextHost: 2, members: [], requests: [] });
			const founding = make(dirs[0]!);
			const restored = make(dirs[1]!);
			await restored.importCA(NET, (await founding.exportCA(NET)).caKey);
			const request = (peerID: string) => ({ type: 'lish-overlay-request', networkID: NET, name: 'm', peerID, publicKey: '-----BEGIN NEBULA X25519 PUBLIC KEY-----\nx\n-----END NEBULA X25519 PUBLIC KEY-----', created: '2026-01-01T00:00:00Z' });
			await founding.issue(request(first));
			await restored.issue(request(second));
			const given = [(await founding.listMembers(NET)).find(m => m.peerID === first)!.vpnIP, (await restored.listMembers(NET)).find(m => m.peerID === second)!.vpnIP];
			expect(given[0]).not.toBe(given[1]);
		} finally {
			issue.mockRestore();
			for (const dir of dirs) await rm(dir, { recursive: true, force: true });
		}
	});

	// A full lane fell back to the whole subnet and handed out an address in another device's lane.
	it('a device whose lane is full takes another free lane, never an address in a lane another device holds', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'overlay-ca-'));
		const issue = spyOn(OverlayAccess.prototype as any, 'issueCertificate').mockImplementation(async (..._args: unknown[]) => ({ cert: 'crt', fingerprint: 'f'.repeat(64), notAfter: '2099-01-01T00:00:00Z' }));
		try {
			const access = new OverlayAccess({
				nodes: { network: () => undefined, store: (id: string) => new OverlayStore(dir, id), ownCertificate: async () => MEMBER_CERT, currentState: async () => null, knownRevocations: async () => ({ fingerprints: [], peers: {} }) } as any,
				getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
				addNetwork: async () => {},
				listOverlayIDs: () => [],
				refresh: async () => {},
				emit: () => {},
			});
			const store = new OverlayStore(dir, NET);
			await store.ensureDir();
			await store.writeText('ca.key', 'key');
			const member = (host: number) => ({ name: `m${host}`, peerID: `p${host}`, vpnIP: `100.64.0.${host}`, roles: [], notAfter: '2099-01-01T00:00:00Z', fingerprint: String(host).padStart(64, '0'), issued: '', revoked: false });
			// Lane 0 full; a restored device holds lane 5.
			await store.writeJSON('founder.json', { nextHost: 2, lane: 0, lanes: [0, 5], members: Array.from({ length: 254 }, (_, i) => member(i + 2)), requests: [] });
			// A peer ID whose slot in the whole subnet (the old fallback) lies in lane 5.
			const base58 = (n: number): string => (n < 58 ? '' : base58(Math.floor(n / 58))) + '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[n % 58];
			const wholeLane = (id: string): number => (2 + (createHash('sha256').update(id).digest().readUInt32BE(0) % (255 * 256 - 2))) >> 8;
			let peerID = '';
			for (let i = 0; !peerID; i++) if (wholeLane(`3${base58(i)}`.padEnd(46, '3')) === 5) peerID = `3${base58(i)}`.padEnd(46, '3');
			await access.issue({ type: 'lish-overlay-request', networkID: NET, name: 'new', peerID, publicKey: '-----BEGIN NEBULA X25519 PUBLIC KEY-----\nx\n-----END NEBULA X25519 PUBLIC KEY-----', created: '2026-01-01T00:00:00Z' });
			const data = await store.readFounder();
			const lane = Number(data.members.find(m => m.peerID === peerID)!.vpnIP.split('.')[2]);
			expect([0, 5, 255]).not.toContain(lane);
			expect(data.extraLanes).toEqual([lane]);
			expect(data.lanes).toContain(lane);
		} finally {
			issue.mockRestore();
			await rm(dir, { recursive: true, force: true });
		}
	});

	// A running host with a valid certificate of its own restored a backup that revoked a member: the revocation sat
	// on disk while the running helper kept the old blocklist and the member went on transferring.
	it('applies a restored backup to a node that already runs', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'overlay-ca-'));
		const reconfigured: string[] = [];
		try {
			const ca = await generateKeyPair('Ed25519');
			const access = new OverlayAccess({
				nodes: { network: () => undefined, store: (id: string) => new OverlayStore(dir, id), caPublicKey: async () => Buffer.from(ca.publicKey.raw).toString('hex'), ownCertificate: async () => MEMBER_CERT, currentState: async () => null, knownRevocations: async () => ({ fingerprints: [], peers: {} }), reconfigure: async (id: string) => void reconfigured.push(id), sweepRevokedPeers: async () => {} } as any,
				getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
				addNetwork: async () => {},
				listOverlayIDs: () => [],
				refresh: async () => {},
				emit: () => {},
			});
			const list = Buffer.from(JSON.stringify({ nextHost: 2, members: [], revoked: ['b'.repeat(64)] })).toString('base64');
			await access.importCA(NET, `${pem(ca.raw)}-----BEGIN LISH OVERLAY MEMBERS-----\n${list}\n-----END LISH OVERLAY MEMBERS-----\n`);
			expect(reconfigured).toEqual([NET]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('refuses a backup whose member list is damaged', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'overlay-ca-'));
		try {
			const ca = await generateKeyPair('Ed25519');
			const access = new OverlayAccess({
				nodes: { network: () => undefined, store: (id: string) => new OverlayStore(dir, id), caPublicKey: async () => Buffer.from(ca.publicKey.raw).toString('hex') } as any,
				getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
				addNetwork: async () => {},
				listOverlayIDs: () => [],
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
