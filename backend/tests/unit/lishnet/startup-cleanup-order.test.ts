import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Mutex } from 'async-mutex';
import { Networks } from '../../../src/lishnet/lishnets.ts';
import { addLISHnet, initLISHnetsTables } from '../../../src/db/lishnets.ts';
import { recordPeerCleanup } from '../../../src/db/peer-cleanup.ts';

const peer = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(r => { resolve = r; });
	return { promise, resolve };
}

for (const stopDuringCleanup of [false, true]) {
	test(`catalog writes wait for startup cleanup without deadlocking stop=${stopDuringCleanup}`, async () => {
		const db = new Database(':memory:');
		initLISHnetsTables(db);
		addLISHnet(db, { networkID: 'remaining', name: 'Remaining', description: '', created: '2026-01-01T00:00:00Z', enabled: false, bootstrapPeers: [`/ip4/192.0.2.1/tcp/9090/p2p/${peer}`] });
		recordPeerCleanup(db, 'left', [peer], 'leave');
		const deleting = deferred(), finishDelete = deferred();
		const lifecycle = new Mutex();
		let running = false;
		const net = {
			start: async (_peers: string[], options: any) => lifecycle.runExclusive(async () => {
				await options.beforeStart({ peerStore: { delete: async () => { deleting.resolve(); await finishDelete.promise; } } });
				running = true;
			}),
			stop: async () => lifecycle.runExclusive(() => { running = false; }),
			isRunning: () => running, isStopTerminal: () => false, getRunEpoch: () => 1,
			cancelRunOperations() {}, subscribeTopic: () => true, clearRedialSuppressionForNetwork() {},
			addBootstrapPeers: async () => 'completed', getTopicPeers: () => [], getRecentTopicMembers: () => [],
		};
		const networks = new Networks(db, '.', {} as never, {} as never);
		(networks as any).network = net;
		const starting = networks.startEnabledNetworks();
		await deleting.promise;
		const changing = networks.setEnabled('remaining', true);
		const stopping = stopDuringCleanup ? networks.stopAllNetworks() : Promise.resolve();
		try {
			await Bun.sleep(20);
			expect(networks.get('remaining')?.enabled).toBe(false);
		} finally {
			finishDelete.resolve();
			const settled = Promise.all([starting, changing, stopping]);
			try {
				expect(await Promise.race([settled.then(() => 'settled'), Bun.sleep(2000).then(() => 'deadlock')])).toBe('settled');
				expect(networks.get('remaining')?.enabled).toBe(true);
			} finally { db.close(); }
		}
	});
}
