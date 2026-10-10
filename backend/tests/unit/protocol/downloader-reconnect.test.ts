import { describe, it, expect, afterEach } from 'bun:test';
import { Downloader } from '../../../src/protocol/downloader.ts';
import { MockNetwork } from '../helpers/mock-network.ts';
import { MockDataServer, MockLISHClient, makeLISH, priv } from './downloader-test-helpers.ts';

/**
 * A seeder whose connection dies mid-transfer still has the data. It must be dialed again at
 * once, not left in quarantine until its next HAVE — which its want cooldown delays a minute.
 */
class DialingNetwork extends MockNetwork {
	dials: Array<{ kind: 'addrs' | 'id'; target: string }> = [];
	failDials = false;
	override async dialProtocol(multiaddrs: unknown[]): Promise<never> {
		this.dials.push({ kind: 'addrs', target: String(multiaddrs[0]) });
		if (this.failDials) throw new Error('dial failed');
		return { stream: new MockLISHClient(), connectionType: 'RELAY' } as never;
	}
	override async dialProtocolByPeerId(peerID: string): Promise<never> {
		this.dials.push({ kind: 'id', target: peerID });
		if (this.failDials) throw new Error('dial failed');
		return { stream: new MockLISHClient(), connectionType: 'DIRECT' } as never;
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
});
