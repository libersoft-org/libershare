import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LISHNetworkConfig } from '@shared';
import { OverlayAccess } from '../../../src/overlay/overlay-access.ts';
import { OverlayStore } from '../../../src/overlay/overlay-store.ts';

const NET = 'net-hosts';

/** A founder restored on a clean device signed its next state without the earlier revocations, and members unblocked them. */
test('a new state keeps every revocation of the member list, even without a stored state', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'overlay-hosts-'));
	try {
		const row: LISHNetworkConfig = { networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } };
		const published: string[][] = [];
		const access = new OverlayAccess({
			nodes: { store: (id: string) => new OverlayStore(dir, id), currentState: async () => null, knownRevocations: async () => ({ fingerprints: [], peers: {} }), publishNewState: async (_id: string, change: { revoked: string[] }) => void published.push(change.revoked) } as any,
			getRow: () => row,
			addNetwork: async () => {},
			listOverlayIDs: () => [],
			refresh: async () => {},
			emit: () => {},
		});
		const store = new OverlayStore(dir, NET);
		await store.ensureDir();
		await store.writeText('ca.key', 'key');
		const revoked = 'e'.repeat(64);
		await store.writeJSON('founder.json', { nextHost: 3, members: [{ name: 'gone', peerID: 'p', vpnIP: '100.64.0.2', roles: [], notAfter: '2099-01-01T00:00:00Z', fingerprint: revoked, issued: '2026-01-01T00:00:00Z', revoked: true }], requests: [] });
		await access.setHosts(NET, [], []);
		expect(published).toEqual([[revoked]]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/**
 * Revoking a member revoked the certificates this device knew; one another device holding the CA key had issued (a
 * renewal) stayed valid. The member is revoked by peer ID, and a later approval starts after the revocation.
 */
test('revoking a member revokes it by peer ID, and approving it again issues a certificate valid after that', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'overlay-hosts-'));
	const peerID = '1'.repeat(46);
	const signed: unknown[][] = [];
	const issue = spyOn(OverlayAccess.prototype as any, 'issueCertificate').mockImplementation(async (...args: unknown[]) => (signed.push(args), { cert: 'crt', fingerprint: 'f'.repeat(64), notAfter: '2099-01-01T00:00:00Z' }));
	try {
		const row: LISHNetworkConfig = { networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } };
		const published: Array<{ revokedPeers?: Record<string, string> }> = [];
		const access = new OverlayAccess({
			nodes: { store: (id: string) => new OverlayStore(dir, id), ownCertificate: async () => null, currentState: async () => null, knownRevocations: async () => ({ fingerprints: [], peers: {} }), publishNewState: async (_id: string, change: any) => void published.push(change) } as any,
			getRow: () => row,
			addNetwork: async () => {},
			listOverlayIDs: () => [],
			refresh: async () => {},
			emit: () => {},
		});
		const store = new OverlayStore(dir, NET);
		await store.ensureDir();
		await store.writeText('ca.key', 'key');
		const first = 'a'.repeat(64);
		await store.writeJSON('founder.json', { nextHost: 3, members: [{ name: 'm', peerID, vpnIP: '100.64.0.2', roles: [], notAfter: '2099-01-01T00:00:00Z', fingerprint: first, issued: '', revoked: false }], requests: [] });
		const before = Date.now();
		await access.revoke(NET, first);
		const revokedAt = published[0]?.revokedPeers?.[peerID];
		expect(Date.parse(revokedAt ?? '')).toBeGreaterThanOrEqual(before - 1);
		const request = { type: 'lish-overlay-request', networkID: NET, name: 'm', peerID, publicKey: '-----BEGIN NEBULA X25519 PUBLIC KEY-----\nx\n-----END NEBULA X25519 PUBLIC KEY-----', created: '2026-01-01T00:00:00Z' };
		await access.issue(request);
		const notBefore = signed[0]?.[6] as string | undefined;
		expect(Date.parse(notBefore ?? '')).toBeGreaterThan(Date.parse(revokedAt!));
		expect(Date.parse(notBefore ?? '')).toBeLessThanOrEqual(Date.now());
	} finally {
		issue.mockRestore();
		await rm(dir, { recursive: true, force: true });
	}
});

/** Two hosts approved at once: each published the host list it had read before the other's change, and one host was lost. */
test('concurrent approvals of hosts keep both of them', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'overlay-hosts-'));
	let serial = 0;
	const issue = spyOn(OverlayAccess.prototype as any, 'issueCertificate').mockImplementation(async (..._args: unknown[]) => ({ cert: 'crt', fingerprint: String(++serial).padStart(64, '0'), notAfter: '2099-01-01T00:00:00Z' }));
	try {
		const row: LISHNetworkConfig = { networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } };
		const access = new OverlayAccess({
			nodes: {
				store: (id: string) => new OverlayStore(dir, id),
				ownCertificate: async () => null,
				currentState: async () => null,
				knownRevocations: async () => ({ fingerprints: [], peers: {} }),
				// Signing and adopting the state takes a while, as with the real CA key and node.
				publishNewState: async (_id: string, change: { lighthouses: any[]; relays: any[] }) => {
					await Bun.sleep(20);
					row.overlay = { ...row.overlay!, lighthouses: change.lighthouses, relays: change.relays };
				},
			} as any,
			getRow: () => row,
			addNetwork: async () => {},
			listOverlayIDs: () => [],
			refresh: async () => {},
			emit: () => {},
		});
		const store = new OverlayStore(dir, NET);
		await store.ensureDir();
		await store.writeText('ca.key', 'key');
		const request = (n: number) => ({ type: 'lish-overlay-request', networkID: NET, name: `host${n}`, peerID: String(n).repeat(46), publicKey: '-----BEGIN NEBULA X25519 PUBLIC KEY-----\nx\n-----END NEBULA X25519 PUBLIC KEY-----', infraAddr: `203.0.113.${n}:4242`, created: '2026-01-01T00:00:00Z' });
		await Promise.all([access.issue(request(1), { roles: ['lighthouse', 'relay'] }), access.issue(request(2), { roles: ['lighthouse', 'relay'] })]);
		expect(row.overlay!.lighthouses.map(h => h.addr).sort()).toEqual(['203.0.113.1:4242', '203.0.113.2:4242']);
		expect(row.overlay!.relays).toHaveLength(2);
	} finally {
		issue.mockRestore();
		await rm(dir, { recursive: true, force: true });
	}
});
