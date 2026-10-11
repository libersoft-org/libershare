import { describe, it, expect, afterEach } from 'bun:test';
import { Downloader } from '../../../src/protocol/downloader.ts';
import { MockNetwork } from '../helpers/mock-network.ts';
import type { ChunkID } from '@shared';
import { MockDataServer, MockLISHClient, makeLISH, makeMissingChunk, priv } from './downloader-test-helpers.ts';

/**
 * A seeder whose connection dies mid-transfer still has the data. It must be dialed again at
 * once, not left in quarantine until its next HAVE — which its want cooldown delays a minute.
 */
class DialingNetwork extends MockNetwork {
	dials: Array<{ kind: 'addrs' | 'id'; target: string }> = [];
	failDials = false;
	/** When set, every dial waits for it — a dial still in flight while the test changes the download. */
	gate: Promise<void> | undefined;
	aborted = 0;
	private stream(): MockLISHClient {
		const stream = new MockLISHClient() as MockLISHClient & { abort(): void };
		stream.abort = (): void => {
			this.aborted++;
		};
		return stream;
	}
	override async dialProtocol(multiaddrs: unknown[]): Promise<never> {
		this.dials.push({ kind: 'addrs', target: String(multiaddrs[0]) });
		await this.gate;
		if (this.failDials) throw new Error('dial failed');
		return { stream: this.stream(), connectionType: 'RELAY' } as never;
	}
	override async dialProtocolByPeerId(peerID: string): Promise<never> {
		this.dials.push({ kind: 'id', target: peerID });
		await this.gate;
		if (this.failDials) throw new Error('dial failed');
		return { stream: this.stream(), connectionType: 'DIRECT' } as never;
	}
}

const RELAYED = '/ip4/198.51.100.7/tcp/9090/p2p/12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo/p2p-circuit';

async function setup(): Promise<{ dl: Downloader; net: DialingNetwork }> {
	const net = new DialingNetwork();
	const ds = new MockDataServer();
	ds.missingChunks = [];
	const dl = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
	await dl.initFromManifest(makeLISH());
	// No real chunk transfer: a reconnect only has to put the peer back.
	(dl as any).doWork = async (): Promise<void> => {};
	return { dl, net };
}

const lost = (dl: Downloader, peerID: string): void => (dl as any).onPeerConnectionLost(peerID);
const peerManager = (dl: Downloader): { has(id: string): boolean; isDropped(id: string): boolean } => priv(dl)['peerManager'] as never;
const settle = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

describe('Downloader – reconnecting a seeder after a lost connection', () => {
	let dl: Downloader | undefined;
	afterEach(async () => {
		await dl?.destroy();
		dl = undefined;
	});

	it('redials through the addresses of its last HAVE', async () => {
		const s = await setup();
		dl = s.dl;
		(dl as any).seederHave.set('peer-relayed', { multiaddrs: [RELAYED], chunks: 'all' });

		lost(dl, 'peer-relayed');
		await settle(1300);

		expect(s.net.dials).toEqual([{ kind: 'addrs', target: RELAYED }]);
		expect(peerManager(dl).has('peer-relayed')).toBe(true);
	});

	it('dials by identity a peer that was found without a HAVE', async () => {
		const s = await setup();
		dl = s.dl;

		lost(dl, 'peer-neighbour');
		await settle(1300);

		expect(s.net.dials).toEqual([{ kind: 'id', target: 'peer-neighbour' }]);
		expect(peerManager(dl).has('peer-neighbour')).toBe(true);
	});

	it('quarantines a peer whose connection keeps dying instead of redialing forever', async () => {
		const s = await setup();
		dl = s.dl;
		s.net.failDials = true;

		lost(dl, 'peer-flaky');
		// Attempts 1 s, 2 s and 3 s apart; the third failure exhausts the budget.
		await settle(6500);

		expect(s.net.dials.length).toBe(3);
		expect(peerManager(dl).isDropped('peer-flaky')).toBe(true);
	}, 10_000);

	it('stops a pending reconnect when the download is disabled', async () => {
		const s = await setup();
		dl = s.dl;

		lost(dl, 'peer-late');
		dl.disable();
		await settle(1300);

		expect(s.net.dials).toEqual([]);
	});

	it('cancels a pending reconnect when another seeder completes the download', async () => {
		const s = await setup();
		dl = s.dl;

		lost(dl, 'peer-a');
		(dl as any).transitionTo('downloaded', 'test: last chunk came from another seeder', true);
		await settle(1300);

		expect(s.net.dials).toEqual([]);
		expect(peerManager(dl).has('peer-a')).toBe(false);
	});

	it('resumes the transfer right after the last seeder reconnects, without waiting out the exhausted-run pause', async () => {
		const net = new DialingNetwork();
		const ds = new MockDataServer();
		ds.missingChunks = [makeMissingChunk('chunk-left' as ChunkID)];
		dl = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
		await dl.initFromManifest(makeLISH());
		// Real doWork(); only the chunk transfer itself is recorded instead of run.
		const runs: number[] = [];
		(dl as any).chunkDownloader.run = async (): Promise<void> => void runs.push(Date.now());
		(dl as any).missingChunks = ds.getMissingChunks('');
		(dl as any).transitionTo('downloading', 'test', true);
		// The chunk run just ended because its only seeder dropped.
		(dl as any).lastExhaustedTime = Date.now();

		lost(dl, 'peer-back');
		await settle(1300);

		// The run started within the reconnect delay, not after the 10 s pause.
		expect(net.dials).toEqual([{ kind: 'id', target: 'peer-back' }]);
		expect(runs.length).toBe(1);
	});

	it('does not redial a seeder of a lishnet we left while the download goes on through another', async () => {
		const s = await setup();
		dl = s.dl;
		(dl as any).seederHave.set('peer-left-net', { multiaddrs: [RELAYED], chunks: 'all' });

		lost(dl, 'peer-left-net');
		// Leaving the lishnet: the download keeps its other networks, the network layer suppresses the peer.
		dl.removeNetwork('net-001');
		s.net.dialSuppressed.add('peer-left-net');
		await settle(1300);

		expect(s.net.dials).toEqual([]);
		expect(peerManager(dl).has('peer-left-net')).toBe(false);
	});

	it('drops a reconnect whose lishnet was left while the dial ran', async () => {
		const s = await setup();
		dl = s.dl;
		let release!: () => void;
		s.net.gate = new Promise(r => (release = r));

		lost(dl, 'peer-left-net');
		await settle(1100);
		s.net.dialSuppressed.add('peer-left-net');
		release();
		await settle(50);

		expect(peerManager(dl).has('peer-left-net')).toBe(false);
		expect(s.net.aborted).toBe(1);
	});

	it('does not let an older reconnect bring back a seeder dropped since', async () => {
		const s = await setup();
		dl = s.dl;

		lost(dl, 'peer-refused');
		// Before the timer fires the peer came back on its own, refused to serve and was dropped.
		(priv(dl)['peerManager'] as { remove(id: string, kind: string): void }).remove('peer-refused', 'drop');
		await settle(1300);

		expect(s.net.dials).toEqual([]);
		expect(peerManager(dl).has('peer-refused')).toBe(false);
	});

	for (const viaHave of [true, false]) {
		it(`drops a reconnect ${viaHave ? 'by HAVE addresses' : 'by peer ID'} that finishes after the download was stopped`, async () => {
			const s = await setup();
			dl = s.dl;
			if (viaHave) (dl as any).seederHave.set('peer-slow', { multiaddrs: [RELAYED], chunks: 'all' });
			let release!: () => void;
			s.net.gate = new Promise(r => (release = r));

			lost(dl, 'peer-slow');
			await settle(1100);
			expect(s.net.dials.length).toBe(1);
			dl.disable();
			release();
			await settle(50);

			expect(peerManager(dl).has('peer-slow')).toBe(false);
			expect(s.net.aborted).toBe(1);
		});
	}
});
