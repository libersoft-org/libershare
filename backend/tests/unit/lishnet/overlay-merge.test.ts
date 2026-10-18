import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ILISHNetwork } from '@shared';
import { initLISHnetsTables } from '../../../src/db/lishnets.ts';
import { Networks } from '../../../src/lishnet/lishnets.ts';

/**
 * A protected lishnet's definition is trusted once, when it is first imported. Afterwards its CA cannot be swapped
 * and its hosts change only through the founder's signed state: a doctored file with "newer" hosts could otherwise
 * make members send packets to a host that learns their addresses.
 */

const CA = '-----BEGIN NEBULA CERTIFICATE V2-----\nAAAA\n-----END NEBULA CERTIFICATE V2-----\n';
const definition = (overlay: Record<string, unknown>): ILISHNetwork => ({
	networkID: 'p1',
	name: 'Protected',
	bootstrapPeers: [],
	overlay: { type: 'nebula', caCert: CA, subnet: '100.64.0.0/16', lighthouses: [{ vpnIP: '100.64.0.1', addr: '203.0.113.7:4242' }], relays: [], lanDirect: false, version: 0, ...overlay } as any,
});

async function networks(): Promise<{ networks: Networks; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), 'overlay-merge-'));
	const db = new Database(':memory:');
	initLISHnetsTables(db);
	return { networks: new Networks(db, dir, {} as any, { list: () => ({ network: {} }) } as any), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe('protected lishnet definitions on re-import', () => {
	it('keep the stored hosts when a file claims a newer version', async () => {
		const { networks: n, cleanup } = await networks();
		try {
			await n.importFromLISHnet(definition({}));
			await n.importFromLISHnet(definition({ version: 99, lighthouses: [{ vpnIP: '100.64.0.9', addr: '198.51.100.66:4242' }] }));
			expect(n.get('p1')?.overlay?.lighthouses).toEqual([{ vpnIP: '100.64.0.1', addr: '203.0.113.7:4242' }]);
			expect(n.get('p1')?.overlay?.version).toBe(0);
		} finally {
			await cleanup();
		}
	});

	it('refuse a definition with another CA and stay protected without one', async () => {
		const { networks: n, cleanup } = await networks();
		try {
			await n.importFromLISHnet(definition({}));
			await expect(n.importFromLISHnet(definition({ caCert: CA.replace('AAAA', 'BBBB') }))).rejects.toThrow('another certificate authority');
			const { overlay: _o, ...plain } = definition({});
			await n.importFromLISHnet(plain);
			expect(n.get('p1')?.overlay?.caCert).toBe(CA);
		} finally {
			await cleanup();
		}
	});

	// The public node stayed joined to the topic of a row that said "protected".
	it('refuse to turn a public lishnet into a protected one', async () => {
		const { networks: n, cleanup } = await networks();
		try {
			const { overlay: _o, ...plain } = definition({});
			await n.importFromLISHnet(plain);
			await expect(n.importFromLISHnet(definition({}))).rejects.toThrow('already exists as a public one');
			expect(n.get('p1')?.overlay).toBeUndefined();
		} finally {
			await cleanup();
		}
	});
});
