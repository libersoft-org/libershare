import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OverlayAccess } from '../../../src/overlay/overlay-access.ts';
import { OverlayStore } from '../../../src/overlay/overlay-store.ts';

const NET = 'net-renew';
const DAY = 86_400_000;

// Device A of the founder shortened a membership; a longer certificate device B had issued, which A never saw, stayed valid.
describe('shortening a membership', () => {
	it('revokes the member by peer ID and issues the shorter certificate valid only after that', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'overlay-shorten-'));
		const issued: Array<string | undefined> = [];
		const issue = spyOn(OverlayAccess.prototype as any, 'issueCertificate').mockImplementation(async (...args: unknown[]) => (issued.push(args[6] as string | undefined), { cert: 'crt', fingerprint: 'b'.repeat(64), notAfter: args[5] as string }));
		const published: Array<Record<string, string>> = [];
		try {
			const peerID = '1'.repeat(46);
			const access = new OverlayAccess({
				nodes: { store: (id: string) => new OverlayStore(dir, id), ownCertificate: async () => null, currentState: async () => null, knownRevocations: async () => ({ fingerprints: [], peers: {} }), publishNewState: async (_id: string, change: { revokedPeers: Record<string, string> }) => void published.push(change.revokedPeers) } as any,
				getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
				addNetwork: async () => {},
				listOverlayIDs: () => [],
				refresh: async () => {},
				emit: () => {},
			});
			const store = new OverlayStore(dir, NET);
			await store.ensureDir();
			await store.writeText('ca.key', 'key');
			await store.writeJSON('founder.json', { nextHost: 2, lane: 0, members: [{ name: 'm', peerID, vpnIP: '100.64.0.7', roles: [], notAfter: new Date(Date.now() + 365 * DAY).toISOString(), fingerprint: 'a'.repeat(64), issued: '', revoked: false }], requests: [] });
			const before = Date.now();
			await access.issue({ type: 'lish-overlay-request', networkID: NET, name: 'm', peerID, publicKey: '-----BEGIN NEBULA X25519 PUBLIC KEY-----\nx\n-----END NEBULA X25519 PUBLIC KEY-----', created: '2026-01-01T00:00:00Z' }, { validUntil: new Date(Date.now() + DAY).toISOString() });
			const data = await store.readFounder();
			const revokedAt = data.revokedPeers?.[peerID];
			expect(Date.parse(revokedAt!)).toBeGreaterThanOrEqual(before - 1000);
			expect(published[published.length - 1]?.[peerID]).toBe(revokedAt!);
			// Valid only after the revocation, so the revocation keeps every earlier certificate out, and not this one.
			expect(Date.parse(issued[0]!)).toBeGreaterThan(Date.parse(revokedAt!));
		} finally {
			issue.mockRestore();
			await rm(dir, { recursive: true, force: true });
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
