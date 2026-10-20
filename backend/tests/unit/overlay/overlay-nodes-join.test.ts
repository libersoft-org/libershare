import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LISHNetworkConfig } from '@shared';
import { OverlayHelper } from '../../../src/overlay/overlay-helper.ts';
import { OverlayNodes } from '../../../src/overlay/overlay-nodes.ts';
import { OverlayStore } from '../../../src/overlay/overlay-store.ts';
import { Network } from '../../../src/protocol/network.ts';

const NET = 'net-join';

/** The helper died while the node was starting: the join failed, but its scheduled restart started a helper nobody tracked. */
test('a join that fails after the helper died leaves no helper behind', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'overlay-join-'));
	let starts = 0;
	let onExit!: () => void;
	const helperStart = spyOn(OverlayHelper, 'start').mockImplementation(async opts => {
		starts++;
		onExit = () => opts.onExit(1);
		return { isRunning: () => false, stop: async () => {}, setInboundPort: async () => {}, dialPort: 1, token: 't' } as unknown as OverlayHelper;
	});
	const networkStart = spyOn(Network.prototype, 'start').mockImplementation(async () => {
		onExit();
		throw new Error('the helper is gone');
	});
	const networkStop = spyOn(Network.prototype, 'stop').mockImplementation(async () => {});
	try {
		const row: LISHNetworkConfig = { networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } };
		const nodes = new OverlayNodes({ dataDir, dataServer: {} as any, settings: {} as any, getRow: () => row, saveOverlay: () => {}, onPeerCountChange: () => {}, onBootstrapStatusChange: () => {}, onStateChange: () => {} });
		(nodes as any).ownCertificate = async () => ({ name: '12D3KooWGzBgW1mHp7DpLbR2X5yfDN8dRtVYWNw2wXxu3yi1fYM5', networks: ['100.64.0.2/16'] });
		const store = new OverlayStore(dataDir, NET);
		await store.ensureDir();
		await store.writeText('member.key', 'key');
		await expect(nodes.join(row)).rejects.toThrow('the helper is gone');
		// Past the first restart delay (1 s).
		await Bun.sleep(1300);
		expect(starts).toBe(1);
		expect(nodes.isRunning(NET)).toBe(false);
	} finally {
		helperStart.mockRestore();
		networkStart.mockRestore();
		networkStop.mockRestore();
		await rm(dataDir, { recursive: true, force: true });
	}
});
