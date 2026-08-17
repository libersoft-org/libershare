import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Mutex } from 'async-mutex';
import { initLISHnetsTables, addLISHnet, getLISHnet } from '../../../src/db/lishnets.ts';
import { Networks } from '../../../src/lishnet/lishnets.ts';

/**
 * Importing a network writes the database. It must also reach the running node:
 * importing an already-joined network used to leave the live bootstrap list, statuses
 * and autodial addresses on the previous configuration, and importing an active
 * network as disabled left it joined until the next restart.
 */

const NET = 'net-a';
const PEER_A = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
const PEER_B = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fp';
const ADDR_A = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_A}`;
const ADDR_B = `/ip4/203.0.113.10/tcp/9090/p2p/${PEER_B}`;

function makeMockNet() {
	return {
		subscribed: [] as string[],
		unsubscribed: [] as string[],
		dialledLists: [] as Array<{ networkID: string; peers: string[]; origin: string }>,
		prunedStatus: [] as Array<{ networkID: string; keep: string[] }>,
		prunedAddresses: [] as string[][],
		prunedBootstrap: [] as string[],
		getTopicPeers: (): string[] => [],
		getRecentTopicMembers: (): string[] => [],
		isBootstrapOrRelayPeer: (): boolean => false,
		async disconnectPeer(): Promise<void> {},
		pruneConfiguredBootstrapPeer(pid: string): void {
			this.prunedBootstrap.push(pid);
		},
		resetBootstrapStatus(): void {},
		pruneBootstrapAddresses(addresses: string[]): void {
			this.prunedAddresses.push(addresses);
		},
		pruneBootstrapStatus(networkID: string, keep: string[]): void {
			this.prunedStatus.push({ networkID, keep });
		},
		clearRedialSuppressionForNetwork(): void {},
		subscribeTopic(id: string): void {
			this.subscribed.push(id);
		},
		unsubscribeTopic(id: string): void {
			this.unsubscribed.push(id);
		},
		async addBootstrapPeers(peers: string[], networkID: string, origin: string): Promise<void> {
			this.dialledLists.push({ networkID, peers, origin });
		},
	};
}

function bare(db: Database, mock: ReturnType<typeof makeMockNet>, joined: string[]) {
	const networks = Object.create(Networks.prototype) as Networks;
	(networks as any).db = db;
	(networks as any).network = mock;
	(networks as any).joinedNetworks = new Set(joined);
	(networks as any).networkOperations = new Map();
	(networks as any).catalogMutex = new Mutex();
	(networks as any).desiredRevisions = new Map();
	(networks as any).announcedJoined = new Map(joined.map(id => [id, true]));
	return networks;
}

describe('Networks.importFromLISHnet — the runtime follows the import', () => {
	let db: Database;
	let mock: ReturnType<typeof makeMockNet>;

	beforeEach(() => {
		db = new Database(':memory:');
		initLISHnetsTables(db);
		mock = makeMockNet();
	});

	it('switches a joined network over to the imported bootstrap list', async () => {
		addLISHnet(db, { networkID: NET, name: 'A', description: '', bootstrapPeers: [ADDR_A], enabled: true, created: '2026-01-01T00:00:00.000Z' });
		const networks = bare(db, mock, [NET]);

		await networks.importFromLISHnet({ networkID: NET, name: 'A', description: '', bootstrapPeers: [ADDR_B] } as any, true);

		expect(getLISHnet(db, NET)!.bootstrapPeers).toEqual([ADDR_B]);
		expect(mock.prunedStatus).toEqual([{ networkID: NET, keep: [ADDR_B] }]);
		expect(mock.dialledLists).toEqual([{ networkID: NET, peers: [ADDR_B], origin: 'configured' }]);
	});

	it('leaves an active network imported as disabled', async () => {
		addLISHnet(db, { networkID: NET, name: 'A', description: '', bootstrapPeers: [ADDR_A], enabled: true, created: '2026-01-01T00:00:00.000Z' });
		const networks = bare(db, mock, [NET]);

		await networks.importFromLISHnet({ networkID: NET, name: 'A', description: '', bootstrapPeers: [ADDR_A] } as any, false);

		expect(getLISHnet(db, NET)!.enabled).toBe(false);
		expect(mock.unsubscribed).toEqual([NET]);
		expect((networks as any).joinedNetworks.has(NET)).toBe(false);
	});

	it('joins a brand-new network imported as enabled', async () => {
		const networks = bare(db, mock, []);

		await networks.importFromLISHnet({ networkID: NET, name: 'A', description: '', bootstrapPeers: [ADDR_A] } as any, true);

		expect(mock.subscribed).toEqual([NET]);
		expect(mock.dialledLists).toEqual([{ networkID: NET, peers: [ADDR_A], origin: 'configured' }]);
	});

	it('touches nothing at runtime for a disabled network imported as disabled', async () => {
		addLISHnet(db, { networkID: NET, name: 'A', description: '', bootstrapPeers: [ADDR_A], enabled: false, created: '2026-01-01T00:00:00.000Z' });
		const networks = bare(db, mock, []);

		await networks.importFromLISHnet({ networkID: NET, name: 'A', description: '', bootstrapPeers: [ADDR_A] } as any, false);

		expect(mock.subscribed).toEqual([]);
		expect(mock.unsubscribed).toEqual([]);
		expect(mock.dialledLists).toEqual([]);
	});
});

describe('Networks.replace — a wholesale rewrite reaches the runtime', () => {
	it('leaves a joined network the rewrite dropped', async () => {
		const db = new Database(':memory:');
		initLISHnetsTables(db);
		addLISHnet(db, { networkID: NET, name: 'A', description: '', bootstrapPeers: [ADDR_A], enabled: true, created: '2026-01-01T00:00:00.000Z' });
		const mock = makeMockNet();
		const networks = bare(db, mock, [NET]);

		await networks.replace([]);

		expect(mock.unsubscribed).toEqual([NET]);
		expect((networks as any).joinedNetworks.has(NET)).toBe(false);
	});

	it('keeps a re-listed network joined', async () => {
		const db = new Database(':memory:');
		initLISHnetsTables(db);
		addLISHnet(db, { networkID: NET, name: 'A', description: '', bootstrapPeers: [ADDR_A], enabled: true, created: '2026-01-01T00:00:00.000Z' });
		const mock = makeMockNet();
		const networks = bare(db, mock, [NET]);

		await networks.replace([{ networkID: NET, name: 'A', description: '', bootstrapPeers: [ADDR_A], enabled: true, created: '2026-01-01T00:00:00.000Z' }]);

		expect(mock.unsubscribed).toEqual([]);
		expect((networks as any).joinedNetworks.has(NET)).toBe(true);
	});
});

/**
 * Normalisation belongs to the write, not to the caller. Only the two edit paths used to
 * apply it, so import, add and wholesale replace could store whitespace-padded values
 * that fail to parse at dial time, and two spellings of one endpoint that each earn their
 * own probe and their own status row.
 */
describe('bootstrap lists are normalised by whoever writes them', () => {
	const PADDED = `  ${ADDR_A}  `;
	const UPPER = `/dns4/BOOTSTRAP.EXAMPLE.ORG./tcp/9090/p2p/${PEER_A}`;
	const LOWER = `/dns4/bootstrap.example.org/tcp/9090/p2p/${PEER_A}`;

	function db(): Database {
		const d = new Database(':memory:');
		initLISHnetsTables(d);
		return d;
	}

	it('add() trims and drops blanks', async () => {
		const d = db();
		const networks = bare(d, makeMockNet(), []);

		await networks.add({ networkID: NET, name: 'A', description: '', bootstrapPeers: [PADDED, '', '   '], enabled: false, created: '' });

		expect(getLISHnet(d, NET)!.bootstrapPeers).toEqual([ADDR_A]);
	});

	it('addIfNotExists() collapses two spellings of one address', () => {
		const d = db();
		const networks = bare(d, makeMockNet(), []);

		networks.addIfNotExists({ networkID: NET, name: 'A', description: '', bootstrapPeers: [UPPER, LOWER], created: '' });

		expect(getLISHnet(d, NET)!.bootstrapPeers).toEqual([UPPER]);
	});

	it('importNetworks() trims what it stores', () => {
		const d = db();
		const networks = bare(d, makeMockNet(), []);

		networks.importNetworks([{ networkID: NET, name: 'A', description: '', bootstrapPeers: [PADDED], created: '' }]);

		expect(getLISHnet(d, NET)!.bootstrapPeers).toEqual([ADDR_A]);
	});

	it('importFromLISHnet() trims what it stores', async () => {
		const d = db();
		const networks = bare(d, makeMockNet(), []);

		await networks.importFromLISHnet({ networkID: NET, name: 'A', description: '', bootstrapPeers: [PADDED] } as any, false);

		expect(getLISHnet(d, NET)!.bootstrapPeers).toEqual([ADDR_A]);
	});

	it('replace() trims what it stores', async () => {
		const d = db();
		const networks = bare(d, makeMockNet(), []);

		await networks.replace([{ networkID: NET, name: 'A', description: '', bootstrapPeers: [PADDED], enabled: false, created: '' }]);

		expect(getLISHnet(d, NET)!.bootstrapPeers).toEqual([ADDR_A]);
	});

	it('validateNetwork() reports the list in the shape it would be stored in', () => {
		const networks = bare(db(), makeMockNet(), []);

		const definition = networks.validateNetwork({ networkID: NET, name: 'A', description: '', bootstrapPeers: [PADDED, '  '] } as any);

		expect(definition.bootstrapPeers).toEqual([ADDR_A]);
	});
});
