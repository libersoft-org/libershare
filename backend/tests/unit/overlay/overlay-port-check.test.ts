import { describe, expect, it } from 'bun:test';
import { createSocket } from 'node:dgram';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OverlayAccess } from '../../../src/overlay/overlay-access.ts';
import { OverlayStore } from '../../../src/overlay/overlay-store.ts';

/**
 * A lighthouse or relay listens on the UDP port of its public address. With that port taken (another protected
 * lishnet on this computer, another program) the lishnet was created and then never started, with nothing but a
 * log line to say why.
 */
describe('UDP port of a lighthouse or relay', () => {
	it('is refused when this computer already listens on it', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'overlay-port-'));
		const taken = createSocket('udp4');
		await new Promise<void>(resolve => taken.bind(0, '0.0.0.0', resolve));
		const port = taken.address().port;
		try {
			const access = new OverlayAccess({
				nodes: { store: (id: string) => new OverlayStore(dir, id), isRunning: () => false } as any,
				getRow: () => ({ networkID: 'n', name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
				addNetwork: async () => {},
				listOverlayIDs: () => [],
				refresh: async () => {},
				emit: () => {},
			});
			await expect(access.create({ name: 'Second', lighthouseAddr: `203.0.113.7:${port}` })).rejects.toThrow('already in use');
			await expect(access.requestAccess('n', 'relay', `203.0.113.7:${port}`)).rejects.toThrow('already in use');
		} finally {
			taken.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
