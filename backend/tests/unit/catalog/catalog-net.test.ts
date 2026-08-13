import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Ed25519PrivateKey } from '@libp2p/interface';
import { initCatalogTables } from '../../../src/db/catalog.ts';
import { CatalogManager } from '../../../src/catalog/catalog-manager.ts';
import { CatalogNet, type CatalogNetDeps } from '../../../src/catalog/catalog-net.ts';
import { RATE_LIMITS } from '../../../src/catalog/catalog-rate-limiter.ts';
import { signCatalogOp } from '../../../src/catalog/catalog-signer.ts';

let db: Database;
let ownerKey: Ed25519PrivateKey;
let ownerPeerID: string;
let manager: CatalogManager;

interface Captured {
	topicHandlers: Map<string, (msg: Record<string, any>, from?: string) => void | Promise<void>>;
	topicPeersCalls: number;
}

function makeDeps(overrides: Partial<CatalogNetDeps> = {}): { deps: CatalogNetDeps; captured: Captured } {
	const captured: Captured = { topicHandlers: new Map(), topicPeersCalls: 0 };
	const deps: CatalogNetDeps = {
		db,
		getCatalogManager: () => manager,
		subscribe: async (topic, handler) => {
			captured.topicHandlers.set(topic, handler);
		},
		registerStreamHandler: async () => {},
		dialProtocolByPeerId: async () => {
			throw new Error('no dial in unit test');
		},
		getTopicPeers: () => {
			captured.topicPeersCalls++;
			return [];
		},
		syncRetryDelayMs: 10,
		...overrides,
	};
	return { deps, captured };
}

beforeEach(async () => {
	db = new Database(':memory:');
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA foreign_keys = ON');
	initCatalogTables(db);
	ownerKey = await generateKeyPair('Ed25519');
	ownerPeerID = ownerKey.publicKey.toString();
	manager = new CatalogManager({
		db,
		getPrivateKey: () => ownerKey,
		getLocalPeerID: () => ownerPeerID,
	});
	manager.join('net1', ownerPeerID);
});

let opSeq = 0;

async function makeSignedAddOp(key: Ed25519PrivateKey, lishID: string) {
	// Distinct wall times keep successive ops clear of the anti-replay watermark
	const { op } = await signCatalogOp(key, 'add', 'net1', { lishID, name: lishID, chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 1, fileCount: 1, manifestHash: 'h' }, { wallTime: Date.now() + ++opSeq, logical: 0, nodeID: key.publicKey.toString() });
	return op;
}

describe('CatalogNet: live op ingestion', () => {
	test('applies a valid catalog_op received via gossip', async () => {
		const { deps, captured } = makeDeps();
		const net = new CatalogNet(deps);
		await net.attach('net1');
		net.detach('net1');

		const op = await makeSignedAddOp(ownerKey, 'gossip-1');
		const handler = captured.topicHandlers.get('lish/net1')!;
		await handler({ type: 'catalog_op', ...op }, ownerPeerID);
		expect(manager.get('net1', 'gossip-1')).not.toBeNull();
	});

	test('ignores ops with an unknown version', async () => {
		const { deps, captured } = makeDeps();
		const net = new CatalogNet(deps);
		await net.attach('net1');
		net.detach('net1');

		const op = await makeSignedAddOp(ownerKey, 'versioned');
		const handler = captured.topicHandlers.get('lish/net1')!;
		await handler({ type: 'catalog_op', version: 2, ...op }, ownerPeerID);
		expect(manager.get('net1', 'versioned')).toBeNull();
	});

	test('rate-limits a flooding source before ops reach the manager', async () => {
		const { deps, captured } = makeDeps();
		const net = new CatalogNet(deps);
		await net.attach('net1');
		net.detach('net1');

		const handler = captured.topicHandlers.get('lish/net1')!;
		const flooder = 'flooding-peer-id';
		for (let i = 0; i < RATE_LIMITS.maxOpsPerPeerPerMinute + 5; i++) {
			const op = await makeSignedAddOp(ownerKey, `flood-${i}`);
			await handler({ type: 'catalog_op', ...op }, flooder);
		}
		const stored = manager.list('net1', 1000).length;
		expect(stored).toBe(RATE_LIMITS.maxOpsPerPeerPerMinute);
	});
});

describe('CatalogNet: catch-up sync retry lifecycle', () => {
	test('retries while joined and no peers are available', async () => {
		const { deps, captured } = makeDeps();
		const net = new CatalogNet(deps);
		await net.attach('net1');
		await new Promise(r => setTimeout(r, 80));
		net.detach('net1');
		expect(captured.topicPeersCalls).toBeGreaterThan(1);
	});

	test('detach stops the retry chain', async () => {
		const { deps, captured } = makeDeps();
		const net = new CatalogNet(deps);
		await net.attach('net1');
		net.detach('net1');
		const callsAfterDetach = captured.topicPeersCalls;
		await new Promise(r => setTimeout(r, 60));
		expect(captured.topicPeersCalls).toBe(callsAfterDetach);
	});

	test('retry stops when the catalog is no longer joined', async () => {
		const { deps, captured } = makeDeps();
		const net = new CatalogNet(deps);
		await net.attach('net1');
		manager.leave('net1');
		await new Promise(r => setTimeout(r, 60));
		const calls = captured.topicPeersCalls;
		await new Promise(r => setTimeout(r, 60));
		expect(captured.topicPeersCalls).toBe(calls);
		net.detachAll();
	});

	test('repeated attach does not stack parallel retry chains', async () => {
		const { deps, captured } = makeDeps();
		const net = new CatalogNet(deps);
		await net.attach('net1');
		await net.attach('net1');
		await net.attach('net1');
		await new Promise(r => setTimeout(r, 35));
		net.detachAll();
		// 3 immediate attempts + at most a few timer-driven ones — a stacked chain
		// would multiply the count well beyond this bound.
		expect(captured.topicPeersCalls).toBeLessThanOrEqual(7);
	});
});
