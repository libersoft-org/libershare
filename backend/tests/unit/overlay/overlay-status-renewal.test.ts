import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactRevocations, isRevoked, MAX_LIMITS_PER_MEMBER, type OverlayLimit, type OverlayRevocations } from '@shared';
import { OverlayAccess } from '../../../src/overlay/overlay-access.ts';
import { OverlayStore } from '../../../src/overlay/overlay-store.ts';

const NET = 'net-renew';
const DAY = 86_400_000;

const at = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Every approval limits the member's older certificates to the new one's end ({@link OverlayRevocations.limits}). */
describe('changing how long a member stays', () => {
	async function setup(notAfter: number, known: Partial<OverlayRevocations> = {}) {
		const dir = await mkdtemp(join(tmpdir(), 'overlay-shorten-'));
		const control = { failPublish: false };
		const issued: Array<{ notBefore: string; notAfter: string }> = [];
		const issue = spyOn(OverlayAccess.prototype as any, 'issueCertificate').mockImplementation(async (...args: unknown[]) => {
			const cert = { cert: 'crt', fingerprint: String(issued.length).repeat(64), notBefore: args[6] as string, notAfter: args[5] as string };
			issued.push(cert);
			return cert;
		});
		const published: any[] = [];
		const peerID = '1'.repeat(46);
		const access = new OverlayAccess({
			nodes: {
				store: (id: string) => new OverlayStore(dir, id),
				ownCertificate: async () => null,
				currentState: async () => null,
				knownRevocations: async () => ({ fingerprints: [], peers: {}, ...known }),
				publishNewState: async (_id: string, change: unknown) => {
					if (control.failPublish) throw new Error('the state is too large to sign');
					published.push(change);
				},
			} as any,
			getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
			addNetwork: async () => {},
			listOverlayIDs: () => [],
			refresh: async () => {},
			emit: () => {},
		});
		const store = new OverlayStore(dir, NET);
		await store.ensureDir();
		await store.writeText('ca.key', 'key');
		await store.writeJSON('founder.json', { nextHost: 2, lane: 0, members: [{ name: 'm', peerID, vpnIP: '100.64.0.7', roles: [], notAfter: new Date(notAfter).toISOString(), fingerprint: 'a'.repeat(64), issued: '', revoked: false }], requests: [] });
		const approve = (days: number) => access.issue({ type: 'lish-overlay-request', networkID: NET, name: 'm', peerID, publicKey: '-----BEGIN NEBULA X25519 PUBLIC KEY-----\nx\n-----END NEBULA X25519 PUBLIC KEY-----', created: new Date().toISOString() }, { validUntil: new Date(Date.now() + days * DAY).toISOString() });
		const done = async () => {
			issue.mockRestore();
			await rm(dir, { recursive: true, force: true });
		};
		return { store, published, issued, peerID, approve, done, control };
	}

	// A shorter approval revoked the member at once: offline, it could no longer reach the lishnet to fetch the new certificate.
	it('keeps a longer certificate valid until the shorter one ends, and no longer', async () => {
		const f = await setup(Date.now() + 365 * DAY);
		try {
			await f.approve(1);
			const data = await f.store.readFounder();
			expect(data.revokedPeers).toBeUndefined();
			expect(data.members[0]!.revoked).toBe(false);
			expect(data.limits?.[f.peerID]).toEqual([[f.issued[0]!.notBefore, f.issued[0]!.notAfter, data.device!, {}]]);
			expect(f.published[f.published.length - 1]?.limits).toEqual(data.limits);
			const revocations = { fingerprints: [], peers: {}, limits: data.limits! };
			const older = { name: f.peerID, fingerprint: 'a'.repeat(64), notBefore: at(Date.now() - 30 * DAY) };
			expect(isRevoked(revocations, older)).toBe(false);
			expect(isRevoked(revocations, older, Date.now() + 2 * DAY)).toBe(true);
			// The new certificate itself is not limited by its own approval.
			expect(isRevoked(revocations, { name: f.peerID, fingerprint: '0'.repeat(64), notBefore: f.issued[0]!.notBefore }, Date.now() + 2 * DAY)).toBe(false);
		} finally {
			await f.done();
		}
	});

	// Device A shortened a membership it had issued for one day; device B's 30-day certificate, which A never saw, stayed valid.
	it('bounds a certificate another device issued, whatever this device knew of it', async () => {
		const f = await setup(Date.now() + DAY);
		try {
			const fromDeviceB = { name: f.peerID, fingerprint: 'e'.repeat(64), notBefore: at(Date.now() - 3600_000) };
			await f.approve(7);
			const revocations = { fingerprints: [], peers: {}, limits: (await f.store.readFounder()).limits! };
			expect(isRevoked(revocations, fromDeviceB, Date.now() + 6 * DAY)).toBe(false);
			expect(isRevoked(revocations, fromDeviceB, Date.now() + 8 * DAY)).toBe(true);
		} finally {
			await f.done();
		}
	});

	it('starts each certificate after the last approval, so a later longer one is not bounded by an earlier shorter one', async () => {
		const f = await setup(Date.now() + DAY);
		try {
			await f.approve(1);
			await f.approve(30);
			const [first, second] = f.issued;
			expect(Date.parse(second!.notBefore)).toBeGreaterThan(Date.parse(first!.notBefore));
			const revocations = { fingerprints: [], peers: {}, limits: (await f.store.readFounder()).limits! };
			expect(isRevoked(revocations, { name: f.peerID, fingerprint: '1'.repeat(64), notBefore: second!.notBefore }, Date.now() + 20 * DAY)).toBe(false);
			// A certificate older than both stays bounded by the earlier, shorter one: a later approval lengthens only its own.
			expect(isRevoked(revocations, { name: f.peerID, fingerprint: 'a'.repeat(64), notBefore: at(Date.now() - 30 * DAY) }, Date.now() + 2 * DAY)).toBe(true);
		} finally {
			await f.done();
		}
	});

	// The 65th approval was stored with its limit before the state carrying it was refused; every later state, a
	// revocation of another member too, was then refused the same way.
	it('leaves nothing behind when the state an approval needs cannot be signed', async () => {
		const f = await setup(Date.now() + DAY);
		try {
			f.control.failPublish = true;
			await expect(f.approve(30)).rejects.toThrow('too large');
			const data = await f.store.readFounder();
			expect(data.members).toHaveLength(1);
			expect(data.limits).toBeUndefined();
			// The request waits for a decision again.
			expect(data.requests).toHaveLength(1);
			f.control.failPublish = false;
			await f.approve(30);
			expect((await f.store.readFounder()).members).toHaveLength(2);
		} finally {
			await f.done();
		}
	});

	// Device A did not know of device B's longer approval and its clock ran behind: its newer, shorter decision got an
	// earlier start and did not reach B's certificate, so the member kept access past the end A set.
	it('records what it knew of other devices, and their longer certificate ends with its shorter decision', async () => {
		const now = Date.now();
		const fromDeviceB = { name: '1'.repeat(46), fingerprint: 'e'.repeat(64), notBefore: at(now + 3_600_000) };
		const deviceB: OverlayLimit = [fromDeviceB.notBefore, at(now + 300 * DAY), 'bbbbbbbb', {}];
		const deviceC: OverlayLimit = [at(now - DAY), at(now + 300 * DAY), 'cccccccc', {}];
		const f = await setup(now + DAY, { limits: { [fromDeviceB.name]: [deviceC] } });
		try {
			await f.approve(7);
			const data = await f.store.readFounder();
			const own = data.limits![f.peerID]!;
			const mine = own[own.length - 1]!;
			expect(mine[3]).toEqual({ cccccccc: deviceC[0] });
			// B's approval reaches this device later: it started after this one by B's clock, unaware of it.
			const revocations = { fingerprints: [], peers: {}, limits: { [f.peerID]: [...data.limits![f.peerID]!, deviceB] } };
			expect(Date.parse(fromDeviceB.notBefore)).toBeGreaterThan(Date.parse(mine[0]));
			expect(isRevoked(revocations, fromDeviceB, now + 6 * DAY)).toBe(false);
			expect(isRevoked(revocations, fromDeviceB, now + 8 * DAY)).toBe(true);
			expect(isRevoked(compactRevocations(revocations, now + 8 * DAY), fromDeviceB, now + 8 * DAY)).toBe(true);
			// A later renewal by B that knew of this decision is not ended by it.
			const renewed: OverlayLimit = [at(now + 2 * DAY), at(now + 400 * DAY), 'bbbbbbbb', { [data.device!]: mine[0] }];
			const later = { ...revocations, limits: { [f.peerID]: [...revocations.limits[f.peerID]!, renewed] } };
			expect(isRevoked(later, { name: f.peerID, fingerprint: 'd'.repeat(64), notBefore: renewed[0] }, now + 8 * DAY)).toBe(false);
			// This device's own certificate is not ended by B's longer one.
			expect(isRevoked(revocations, { name: f.peerID, fingerprint: '0'.repeat(64), notBefore: mine[0] }, now + 6 * DAY)).toBe(false);
		} finally {
			await f.done();
		}
	});
});

describe('compacted revocations', () => {
	it('revoke the same certificates in less space', () => {
		const now = Date.parse('2026-06-01T00:00:00Z');
		const peer = '1'.repeat(46);
		const r = {
			fingerprints: ['f'.repeat(64)],
			peers: {},
			limits: {
				[peer]: [
					['2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'],
					['2026-03-01T00:00:00Z', '2026-07-01T00:00:00Z'],
				] as Array<[string, string]>,
			},
		};
		const compact = compactRevocations(r, now);
		// The limit that ended is a revocation at its start; the one still running stays.
		expect(compact).toEqual({ fingerprints: ['f'.repeat(64)], peers: { [peer]: '2026-01-01T00:00:00Z' }, limits: { [peer]: [['2026-03-01T00:00:00Z', '2026-07-01T00:00:00Z']] } });
		for (const notBefore of ['2025-12-01T00:00:00Z', '2026-01-15T00:00:00Z', '2026-04-01T00:00:00Z'])
			for (const later of [now, Date.parse('2026-08-01T00:00:00Z')]) {
				const cert = { name: peer, fingerprint: 'a'.repeat(64), notBefore };
				expect(isRevoked(compact, cert, later)).toBe(isRevoked(r, cert, later));
			}
	});

	// Each approval added a limit and states took 64 per member: the 65th approval made a state no node accepted.
	it('stay within the limits a state may carry per member, ending no certificate later', () => {
		const now = Date.parse('2026-06-01T00:00:00Z');
		const peer = '1'.repeat(46);
		const limits: OverlayLimit[] = Array.from({ length: 70 }, (_, i) => [at(now - (100 - i) * 60_000), at(now + (10 + i) * DAY), 'aaaaaaaa', {}]);
		// An older certificate of another device, and two the approvals issued.
		const certs = [{ notBefore: at(now - 200 * 60_000) }, { notBefore: limits[0]![0] }, { notBefore: limits[69]![0] }].map(c => ({ ...c, name: peer, fingerprint: 'a'.repeat(64) }));
		const full = { fingerprints: [], peers: {}, limits: { [peer]: limits } };
		const compact = compactRevocations(full, now);
		expect(compact.limits![peer]!.length).toBeLessThanOrEqual(MAX_LIMITS_PER_MEMBER);
		for (const cert of certs) for (let day = 0; day <= 90; day++) if (isRevoked(full, cert, now + day * DAY)) expect(isRevoked(compact, cert, now + day * DAY)).toBe(true);
		// The newest certificate still lasts to its own end.
		expect(isRevoked(compact, certs[2]!, now + 78 * DAY)).toBe(false);
	});
});

/** A member asks for a renewal before its certificate ends; the request it made must show while it waits. */
describe('member renewal', () => {
	for (const [days, shown] of [
		[90, false],
		[20, true],
	] as const)
		it(`a request is ${shown ? '' : 'not '}shown with ${days} days of the certificate left`, async () => {
			const dir = await mkdtemp(join(tmpdir(), 'overlay-renew-'));
			try {
				const cert = { name: 'self', networks: ['100.64.0.9/16'], groups: [], notBefore: '2026-01-01T00:00:00Z', notAfter: new Date(Date.now() + days * DAY).toISOString(), fingerprint: '9'.repeat(64) };
				const access = new OverlayAccess({
					nodes: { store: (id: string) => new OverlayStore(dir, id), ownCertificate: async () => cert, currentState: async () => null, helperStatus: async () => null, isRunning: () => true, knownRevocations: async () => ({ fingerprints: [], peers: {} }), network: () => undefined } as any,
					getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
					addNetwork: async () => {},
					listOverlayIDs: () => [],
					refresh: async () => {},
					emit: () => {},
				});
				const store = new OverlayStore(dir, NET);
				await store.ensureDir();
				await store.writeJSON('request.json', { type: 'lish-overlay-request', networkID: NET, name: 'self', peerID: '1'.repeat(46), publicKey: 'k', created: '2026-01-01T00:00:00Z' });
				const status = await access.status(NET);
				expect(status.role).toBe('member');
				expect(!!status.request).toBe(shown);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});
});
