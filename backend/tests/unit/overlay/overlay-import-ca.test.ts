import { describe, expect, it } from 'bun:test';
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
});
