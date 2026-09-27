import { expect, test } from 'bun:test';
import { encode as lpEncode } from 'it-length-prefixed';
import { encode } from '../../../src/protocol/codec.ts';
import { Downloader } from '../../../src/protocol/downloader.ts';
import { createProcessShutdown } from '../../../src/shutdown.ts';
import { drainForShutdown } from '../../../src/api/shutdown.ts';

for (const phase of ['probe dial', 'manifest read', 'stream close', 'announcement dial']) {
	test(`shutdown drains a downloader blocked in ${phase} before saving settings`, async () => {
		let entered!: () => void;
		const started = new Promise<void>(resolve => (entered = resolve));
		let release!: () => void;
		const held = new Promise<void>(resolve => (release = resolve));
		const log: string[] = [];
		let aborted = false;
		const stream = {
			status: 'open',
			send: () => true,
			abort() {
				aborted = true;
				log.push('abort');
				release();
			},
			async close() {
				if (phase === 'stream close') {
					entered();
					await held;
				}
			},
			async *[Symbol.asyncIterator]() {
				if (phase === 'manifest read') {
					entered();
					await held;
					throw new Error('aborted');
				}
				yield lpEncode.single(encode({ manifest: null }));
			},
		};
		const dial = async (_peer: unknown, _protocol: string, signal?: AbortSignal) => {
			if (phase.endsWith('dial')) {
				entered();
				const onAbort = () => release();
				signal?.addEventListener('abort', onAbort, { once: true });
				try {
					await held;
					signal?.throwIfAborted();
				} finally {
					signal?.removeEventListener('abort', onAbort);
				}
			}
			return { stream, connectionType: 'DIRECT' };
		};
		const network = { getTopicPeers: () => ['peer-test'], dialProtocolByPeerId: dial, dialProtocol: dial };
		const downloader: any = new Downloader('.', network as never, { getAllChunkCount: () => 1 } as never, 'network-test');
		downloader.lishID = 'lish-test';
		const probing = phase === 'announcement dial'
			? downloader.onHaveAnnouncement({ peerID: 'peer-test', lishID: 'lish-test', chunks: 'all', multiaddrs: ['/ip4/192.0.2.1/tcp/1234'] })
			: downloader.probeTopicPeers();
		const { shutdown } = createProcessShutdown({
			deadlineMs: 1000,
			stopConnectivityCheck() {},
			stopApi: () => drainForShutdown({
				stopBackgroundWork() {},
				stopAllCreates: async () => {},
				drainAcceptedRequests: async () => {},
				prepareMaintenance: async () => ({ drain: async () => {}, release() {} }),
				pauseAllTransfers: async () => {},
				pauseAllLISHMutations: async () => {},
				stopVerifyAll: async () => {},
				clearAllTransfers: () => downloader.destroy(),
				cancelRunOperations() {},
				stopAllNetworks: async () => { log.push('networks'); },
				clearUploadRuntime() {},
				drainUploads: async () => {},
				closeServer() {},
			}),
			flushSettings: async () => { log.push('settings'); },
			closeDatabase: () => log.push('database'),
			exit: code => log.push(`exit ${code}`),
		});
		let stopping: Promise<void> | undefined;
		try {
			expect(await Promise.race([started.then(() => true), Bun.sleep(1000).then(() => false)])).toBe(true);
			stopping = shutdown();
			expect(await Promise.race([stopping.then(() => true), Bun.sleep(500).then(() => false)])).toBe(true);
			if (!phase.endsWith('dial')) expect(aborted).toBe(true);
			expect(log.slice(-4)).toEqual(['networks', 'settings', 'database', 'exit 0']);
		} finally {
			release();
			await probing;
			await (stopping ?? downloader.destroy());
		}
	});
}
