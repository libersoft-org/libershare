import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactRevocations, isRevoked } from '@shared';
import { OverlayAccess } from '../../../src/overlay/overlay-access.ts';
import { OverlayStore } from '../../../src/overlay/overlay-store.ts';

const NET = 'net-renew';
const DAY = 86_400_000;

const at = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Every approval limits the member's older certificates to the new one's end ({@link OverlayRevocations.limits}). */
describe('changing how long a member stays', () => {
	async function setup(notAfter: number) {
		const dir = await mkdtemp(join(tmpdir(), 'overlay-shorten-'));
		const issued: Array<{ notBefore: string; notAfter: string }> = [];
		const issue = spyOn(OverlayAccess.prototype as any, 'issueCertificate').mockImplementation(async (...args: unknown[]) => {
			const cert = { cert: 'crt', fingerprint: String(issued.length).repeat(64), notBefore: args[6] as string, notAfter: args[5] as string };
			issued.push(cert);
			return cert;
		});
		const published: any[] = [];
		const peerID = '1'.repeat(46);
		const access = new OverlayAccess({
			nodes: { store: (id: string) => new OverlayStore(dir, id), ownCertificate: async () => null, currentState: async () => null, knownRevocations: async () => ({ fingerprints: [], peers: {} }), publishNewState: async (_id: string, change: unknown) => void published.push(change) } as any,
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
		return { store, published, issued, peerID, approve, done };
	}

	// A shorter approval revoked the member at once: offline, it could no longer reach the lishnet to fetch the new certificate.
	it('keeps a longer certificate valid until the shorter one ends, and no longer', async () => {
		const f = await setup(Date.now() + 365 * DAY);
		try {
			await f.approve(1);
			const data = await f.store.readFounder();
			expect(data.revokedPeers).toBeUndefined();
			expect(data.members[0]!.revoked).toBe(false);
			expect(data.limits?.[f.peerID]).toEqual([[f.issued[0]!.notBefore, f.issued[0]!.notAfter]]);
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
