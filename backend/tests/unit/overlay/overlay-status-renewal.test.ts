import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OverlayAccess } from '../../../src/overlay/overlay-access.ts';
import { OverlayStore } from '../../../src/overlay/overlay-store.ts';

const NET = 'net-renew';
const DAY = 86_400_000;

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
