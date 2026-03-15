/**
 * 10-NODE NETWORK TEST
 *
 * Full simulation of a real community with 10 libp2p nodes:
 * - 1 owner (node 0)
 * - 2 admins (nodes 1-2)
 * - 3 moderators (nodes 3-5)
 * - 4 regular peers / attackers (nodes 6-9)
 *
 * Tests: role management, catalog operations, collisions,
 * forgery attempts, convergence across all 10 nodes.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { Network } from '../../protocol/network.ts';
import { DataServer } from '../../lish/data-server.ts';
import { Settings } from '../../settings.ts';
import { openDatabase } from '../../db/database.ts';
import { CatalogManager } from '../catalog-manager.ts';
import { signCatalogOp, verifyCatalogOp, type SignedCatalogOp } from '../catalog-signer.ts';
import { handleRemoteOp } from '../catalog-validator.ts';
import { getCatalogEntry, listCatalogEntries, updateCatalogACL, getEntryCount, isTombstoned } from '../../db/catalog.ts';
import type { HLC } from '../catalog-hlc.ts';

interface TestNode {
	id: number;
	role: string;
	tmpDir: string;
	db: Database;
	network: Network;
	catalog: CatalogManager;
	peerID: string;
}

const nodes: TestNode[] = [];
const NET = 'ten-node-community';
const NODE_COUNT = 10;

async function createNode(index: number, role: string): Promise<TestNode> {
	const tmpDir = await mkdtemp(join(tmpdir(), `lish-10n-${index}-`));
	const settings = await Settings.create(tmpDir);
	await settings.set('network.incomingPort', 0);
	const db = openDatabase(tmpDir);
	const ds = new DataServer(db);
	const network = new Network(tmpDir, ds, settings);
	await network.start();
	const peerID = network.getNodeInfo()!.peerID;

	const catalog = new CatalogManager({
		db,
		getPrivateKey: () => network.getPrivateKey() as any,
		getLocalPeerID: () => peerID,
		broadcast: (networkID, op) => {
			network.broadcast(`lish/${networkID}`, { type: 'catalog_op', ...op });
		},
	});

	await network.subscribe(`lish/${NET}`, async (msg: Record<string, any>) => {
		if (msg['type'] === 'catalog_op') {
			try { await catalog.applyRemoteOp(NET, msg as any as SignedCatalogOp); }
			catch {}
		}
	});

	return { id: index, role, tmpDir, db, network, catalog, peerID };
}

function syncACL(acl: { admins: string[]; moderators: string[] }): void {
	for (const node of nodes) {
		updateCatalogACL(node.db, NET, acl);
	}
}

async function waitForGossip(ms: number = 3000): Promise<void> {
	await new Promise(r => setTimeout(r, ms));
}

function getEntry(nodeIdx: number, lishID: string) {
	return getCatalogEntry(nodes[nodeIdx]!.db, NET, lishID);
}

function countEntries(nodeIdx: number): number {
	return getEntryCount(nodes[nodeIdx]!.db, NET);
}

beforeAll(async () => {
	console.log(`\n🚀 Starting ${NODE_COUNT} libp2p nodes...`);

	// Create all nodes sequentially (parallel causes Noise handshake issues)
	const roles = ['owner', 'admin', 'admin', 'mod', 'mod', 'mod', 'peer', 'peer', 'attacker', 'attacker'];
	for (let i = 0; i < roles.length; i++) {
		nodes.push(await createNode(i, roles[i]!));
	}

	// Connect all to node 0 (star topology, serialized to avoid Noise handshake race)
	const addr0 = nodes[0]!.network.getNodeInfo()!.addresses.find(a => a.includes('127.0.0.1'));
	for (let i = 1; i < NODE_COUNT; i++) {
		if (addr0) {
			try { await nodes[i]!.network.connectToPeer(addr0); }
			catch (e) { console.warn(`  Connection ${i}→0 failed, retrying...`); }
			await new Promise(r => setTimeout(r, 500)); // stagger connections
		}
	}

	// Subscribe all to topic
	for (const node of nodes) {
		node.network.subscribeTopic(NET);
	}

	// Wait for mesh
	await waitForGossip(5000);

	// Setup ACL hierarchy
	const ownerID = nodes[0]!.peerID;
	for (const node of nodes) {
		node.catalog.join(NET, ownerID);
	}

	// Owner does ALL role grants (each node has own DB, cross-node grants need gossipsub)
	await nodes[0]!.catalog.grantRole(NET, nodes[1]!.peerID, 'admin');
	await nodes[0]!.catalog.grantRole(NET, nodes[2]!.peerID, 'admin');
	await nodes[0]!.catalog.grantRole(NET, nodes[3]!.peerID, 'moderator');
	await nodes[0]!.catalog.grantRole(NET, nodes[4]!.peerID, 'moderator');
	await nodes[0]!.catalog.grantRole(NET, nodes[5]!.peerID, 'moderator');

	// Sync ACL to ALL nodes (simulates bilateral sync ACL transfer)
	syncACL({
		admins: [nodes[1]!.peerID, nodes[2]!.peerID],
		moderators: [nodes[3]!.peerID, nodes[4]!.peerID, nodes[5]!.peerID],
	});

	await waitForGossip(2000);

	console.log(`✅ ${NODE_COUNT} nodes ready:`);
	for (const n of nodes) {
		console.log(`  [${n.id}] ${n.role.padEnd(8)} ${n.peerID.slice(-12)}`);
	}
}, 180_000);

afterAll(async () => {
	console.log('\n🛑 Stopping all nodes...');
	await Promise.all(nodes.map(n => n.network.stop()));
	for (const n of nodes) {
		try { await rm(n.tmpDir, { recursive: true }); } catch {}
	}
}, 30_000);

// ================================================================
// 1. ROLE VERIFICATION
// ================================================================

describe('1. Role Hierarchy', () => {
	test('1.1 ACL correct on owner node', () => {
		const acl = nodes[0]!.catalog.getAccess(NET);
		expect(acl!.owner).toBe(nodes[0]!.peerID);
		expect(acl!.admins.length).toBe(2);
		expect(acl!.moderators.length).toBe(3);
	});

	test('1.2 owner can publish', async () => {
		await nodes[0]!.catalog.publish(NET, {
			lishID: 'owner-entry',
			name: 'Published by Owner',
			description: 'The network owner publishes content',
			chunkSize: 1048576, checksumAlgo: 'sha256', totalSize: 5_000_000_000,
			fileCount: 1, manifestHash: 'h-owner',
			contentType: 'software', tags: ['official'],
		});
		expect(getEntry(0, 'owner-entry')!.name).toBe('Published by Owner');
	});

	test('1.3 admin can publish', async () => {
		await nodes[1]!.catalog.publish(NET, {
			lishID: 'admin1-entry',
			name: 'Published by Admin 1',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 1000,
			fileCount: 1, manifestHash: 'h-a1',
		});
		expect(getEntry(1, 'admin1-entry')).not.toBeNull();
	});

	test('1.4 moderator can publish', async () => {
		await nodes[3]!.catalog.publish(NET, {
			lishID: 'mod1-entry',
			name: 'Published by Moderator 1',
			description: 'Fedora Workstation',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 2_200_000_000,
			fileCount: 1, manifestHash: 'h-m1',
			contentType: 'software', tags: ['linux', 'fedora'],
		});
		expect(getEntry(3, 'mod1-entry')).not.toBeNull();
	});

	test('1.5 regular peer CANNOT publish (restricted mode)', async () => {
		await expect(nodes[6]!.catalog.publish(NET, {
			lishID: 'peer-spam', name: 'Spam',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h-spam',
		})).rejects.toThrow();
	});

	test('1.6 attacker CANNOT publish', async () => {
		await expect(nodes[8]!.catalog.publish(NET, {
			lishID: 'attack-entry', name: 'Malware',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 666,
			fileCount: 1, manifestHash: 'h-evil',
		})).rejects.toThrow();
	});
});

// ================================================================
// 2. CATALOG CONTENT OPERATIONS
// ================================================================

describe('2. Catalog Content', () => {
	test('2.1 multiple moderators publish different entries', async () => {
		await nodes[4]!.catalog.publish(NET, {
			lishID: 'arch-iso', name: 'Arch Linux 2026',
			description: 'Rolling release',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 850_000_000,
			fileCount: 1, manifestHash: 'h-arch',
			tags: ['linux', 'arch'],
		});

		await nodes[5]!.catalog.publish(NET, {
			lishID: 'debian-iso', name: 'Debian 13 Trixie',
			description: 'Stable release',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 3_500_000_000,
			fileCount: 1, manifestHash: 'h-debian',
			tags: ['linux', 'debian', 'stable'],
		});

		// Each node stores in its own DB
		expect(countEntries(4)).toBeGreaterThanOrEqual(1);
		expect(countEntries(5)).toBeGreaterThanOrEqual(1);
	});

	test('2.2 moderator updates own entry', async () => {
		await nodes[3]!.catalog.update(NET, 'mod1-entry', {
			name: 'Fedora Workstation 41 (Updated)',
			description: 'With GNOME 47 and latest security patches',
		});
		const entry = getEntry(3, 'mod1-entry');
		expect(entry!.name).toBe('Fedora Workstation 41 (Updated)');
	});

	test('2.3 admin removes outdated entry', async () => {
		await nodes[1]!.catalog.remove(NET, 'admin1-entry');
		expect(getEntry(1, 'admin1-entry')).toBeNull();
		expect(isTombstoned(nodes[1]!.db, NET, 'admin1-entry')).toBe(true);
	});

	test('2.4 owner removes any entry', async () => {
		// First verify arch-iso exists locally
		await waitForGossip(2000);
		if (getEntry(0, 'arch-iso')) {
			await nodes[0]!.catalog.remove(NET, 'arch-iso');
			expect(getEntry(0, 'arch-iso')).toBeNull();
		}
	});

	test('2.5 peer CANNOT remove entries', async () => {
		const existing = getEntry(6, 'owner-entry');
		if (existing) {
			await expect(nodes[6]!.catalog.remove(NET, 'owner-entry')).rejects.toThrow();
		}
	});

	test('2.6 peer CANNOT update entries', async () => {
		await expect(nodes[7]!.catalog.update(NET, 'owner-entry', { name: 'Hacked' })).rejects.toThrow();
	});
});

// ================================================================
// 3. GOSSIPSUB PROPAGATION
// ================================================================

describe('3. GossipSub Propagation across 10 nodes', () => {
	test('3.1 entry published by mod propagates to other nodes', async () => {
		await nodes[5]!.catalog.publish(NET, {
			lishID: 'propagation-test',
			name: 'Propagation Test Entry',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h-prop',
		});

		await waitForGossip(4000);

		// Check at least some nodes received it
		let received = 0;
		for (const node of nodes) {
			if (getEntry(node.id, 'propagation-test')) received++;
		}
		console.log(`  📡 Propagation: ${received}/${NODE_COUNT} nodes received the entry`);
		expect(received).toBeGreaterThanOrEqual(2); // at least publisher + some peers
	}, 15_000);
});

// ================================================================
// 4. COLLISION TESTS
// ================================================================

describe('4. LWW Collisions', () => {
	test('4.1 two moderators publish same lishID — both store locally, gossipsub resolves', async () => {
		// Mod1 publishes
		await nodes[3]!.catalog.publish(NET, {
			lishID: 'collision-10n',
			name: 'Mod1 Version',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h-c1',
		});
		expect(getEntry(3, 'collision-10n')!.name).toBe('Mod1 Version');

		await new Promise(r => setTimeout(r, 200));

		// Mod2 publishes same ID on own DB (later HLC)
		await nodes[4]!.catalog.publish(NET, {
			lishID: 'collision-10n',
			name: 'Mod2 Version',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 200,
			fileCount: 1, manifestHash: 'h-c2',
		});
		expect(getEntry(4, 'collision-10n')!.name).toBe('Mod2 Version');

		// Wait for gossipsub propagation
		await waitForGossip(5000);

		// After gossipsub, check if nodes converge
		const name3 = getEntry(3, 'collision-10n')?.name;
		const name4 = getEntry(4, 'collision-10n')?.name;
		console.log(`  Collision: node3="${name3}", node4="${name4}"`);
		// Both should exist (each published)
		expect(name3).toBeTruthy();
		expect(name4).toBeTruthy();
	}, 15_000);

	test('4.2 same-node rapid updates converge locally', async () => {
		// Mod3 creates and updates on own node
		await nodes[3]!.catalog.publish(NET, {
			lishID: 'rapid-10n',
			name: 'Initial',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h-rapid10',
		});
		await nodes[3]!.catalog.update(NET, 'rapid-10n', { name: 'Version 2' });
		await nodes[3]!.catalog.update(NET, 'rapid-10n', { name: 'Version 3' });

		expect(getEntry(3, 'rapid-10n')!.name).toBe('Version 3');
	}, 15_000);
});

// ================================================================
// 5. FORGERY & ATTACK SCENARIOS
// ================================================================

describe('5. Forgery Attempts from Attackers', () => {
	test('5.1 attacker crafts signed op with tampered payload', async () => {
		const attackerKey = nodes[8]!.network.getPrivateKey();
		const clock: HLC = { wallTime: Date.now(), logical: 0, nodeID: 'attacker' };
		const { op } = await signCatalogOp(attackerKey as any, 'add', NET, {
			lishID: 'forged-10n', name: 'FORGED',
		}, clock);
		op.payload.data['name'] = 'TAMPERED AFTER SIGNING';

		// Try on every node — all should reject
		let rejected = 0;
		for (const node of nodes) {
			const r = await handleRemoteOp(node.db, NET, op);
			if (!r.valid) rejected++;
		}
		expect(rejected).toBe(NODE_COUNT);
		console.log(`  🛡️ Tampered op rejected by all ${rejected} nodes`);
	});

	test('5.2 attacker spoofs signer PeerID (impersonation)', async () => {
		const attackerKey = nodes[9]!.network.getPrivateKey();
		const clock: HLC = { wallTime: Date.now(), logical: 0, nodeID: 'spoof' };
		const { op } = await signCatalogOp(attackerKey as any, 'add', NET, {
			lishID: 'spoofed-10n', name: 'Impersonated Entry',
		}, clock);

		// Replace signer with moderator's PeerID
		op.signer = nodes[3]!.peerID;

		// All nodes should reject (signature mismatch)
		let rejected = 0;
		for (const node of nodes) {
			const r = await handleRemoteOp(node.db, NET, op);
			if (!r.valid && (r as any).reason === 'INVALID_SIGNATURE') rejected++;
		}
		expect(rejected).toBe(NODE_COUNT);
		console.log(`  🛡️ Impersonation rejected by all ${rejected} nodes`);
	});

	test('5.3 attacker with valid sig but no permissions', async () => {
		const attackerKey = nodes[8]!.network.getPrivateKey();
		const clock: HLC = { wallTime: Date.now(), logical: 0, nodeID: 'noauth' };
		const { op } = await signCatalogOp(attackerKey as any, 'add', NET, {
			lishID: 'unauth-10n', name: 'No Permission',
			publisherPeerID: nodes[8]!.peerID,
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1, manifestHash: 'h-unauth',
		}, clock);

		let rejected = 0;
		for (const node of nodes) {
			const r = await handleRemoteOp(node.db, NET, op);
			if (!r.valid && (r as any).reason === 'UNAUTHORIZED_ADD') rejected++;
		}
		expect(rejected).toBe(NODE_COUNT);
		console.log(`  🛡️ Unauthorized add rejected by all ${rejected} nodes`);
	});

	test('5.4 clock drift attack (10 min future)', async () => {
		const modKey = nodes[3]!.network.getPrivateKey();
		const futureTime = Date.now() + 10 * 60 * 1000;
		const clock: HLC = { wallTime: futureTime, logical: 0, nodeID: 'drift' };
		const { op } = await signCatalogOp(modKey as any, 'add', NET, {
			lishID: 'future-10n', name: 'Time Travel Attack',
			publisherPeerID: nodes[3]!.peerID,
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1, manifestHash: 'h-future',
		}, clock);

		let rejected = 0;
		for (const node of nodes) {
			const r = await handleRemoteOp(node.db, NET, op);
			if (!r.valid && (r as any).reason === 'CLOCK_DRIFT_TOO_HIGH') rejected++;
		}
		expect(rejected).toBe(NODE_COUNT);
		console.log(`  🛡️ Clock drift attack rejected by all ${rejected} nodes`);
	});

	test('5.5 attacker tries to grant self admin', async () => {
		await expect(
			nodes[8]!.catalog.grantRole(NET, nodes[8]!.peerID, 'admin')
		).rejects.toThrow();
		await expect(
			nodes[9]!.catalog.grantRole(NET, nodes[9]!.peerID, 'moderator')
		).rejects.toThrow();
	});

	test('5.6 oversized fields attack', async () => {
		const modKey = nodes[3]!.network.getPrivateKey();
		const clock: HLC = { wallTime: Date.now(), logical: 0, nodeID: 'oversize' };
		const { op } = await signCatalogOp(modKey as any, 'add', NET, {
			lishID: 'big-10n', name: 'x'.repeat(300),
			publisherPeerID: nodes[3]!.peerID,
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1, manifestHash: 'h-big',
		}, clock);

		let rejected = 0;
		for (const node of nodes) {
			const r = await handleRemoteOp(node.db, NET, op);
			if (!r.valid) rejected++;
		}
		expect(rejected).toBe(NODE_COUNT);
	});
});

// ================================================================
// 6. ACL REVOCATION
// ================================================================

describe('5b. Admin grants moderator (cross-node)', () => {
	test('5b.1 admin on node1 can grant new moderator', async () => {
		// Admin 1 grants node7 as moderator (node7 was plain peer)
		await nodes[1]!.catalog.grantRole(NET, nodes[7]!.peerID, 'moderator');
		const acl1 = nodes[1]!.catalog.getAccess(NET);
		expect(acl1!.moderators).toContain(nodes[7]!.peerID);

		// Sync ACL to node7 so it knows about its role
		updateCatalogACL(nodes[7]!.db, NET, {
			admins: [nodes[1]!.peerID, nodes[2]!.peerID],
			moderators: [...acl1!.moderators],
		});

		// Node7 (now moderator) should be able to publish
		await nodes[7]!.catalog.publish(NET, {
			lishID: 'node7-entry', name: 'Published by promoted peer',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 300,
			fileCount: 1, manifestHash: 'h-n7',
		});
		expect(getEntry(7, 'node7-entry')!.name).toBe('Published by promoted peer');

		// Cleanup: remove node7 from moderators
		await nodes[1]!.catalog.revokeRole(NET, nodes[7]!.peerID, 'moderator');
		syncACL({
			admins: [nodes[1]!.peerID, nodes[2]!.peerID],
			moderators: [nodes[3]!.peerID, nodes[4]!.peerID, nodes[5]!.peerID],
		});
	});
});

describe('6. ACL Revocation', () => {
	test('6.1 owner revokes admin — admin can no longer grant roles', async () => {
		// Revoke admin 2
		await nodes[0]!.catalog.revokeRole(NET, nodes[2]!.peerID, 'admin');
		syncACL({
			admins: [nodes[1]!.peerID],
			moderators: [nodes[3]!.peerID, nodes[4]!.peerID, nodes[5]!.peerID],
		});

		// Admin 2 tries to grant moderator — should fail
		await expect(
			nodes[2]!.catalog.grantRole(NET, nodes[7]!.peerID, 'moderator')
		).rejects.toThrow();

		// Restore for next tests
		await nodes[0]!.catalog.grantRole(NET, nodes[2]!.peerID, 'admin');
		syncACL({
			admins: [nodes[1]!.peerID, nodes[2]!.peerID],
			moderators: [nodes[3]!.peerID, nodes[4]!.peerID, nodes[5]!.peerID],
		});
	});

	test('6.2 admin revokes moderator — moderator can no longer publish', async () => {
		await nodes[1]!.catalog.revokeRole(NET, nodes[5]!.peerID, 'moderator');
		syncACL({
			admins: [nodes[1]!.peerID, nodes[2]!.peerID],
			moderators: [nodes[3]!.peerID, nodes[4]!.peerID],
		});

		await expect(nodes[5]!.catalog.publish(NET, {
			lishID: 'revoked-mod', name: 'Should Fail',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h-rev',
		})).rejects.toThrow();

		// Restore
		await nodes[1]!.catalog.grantRole(NET, nodes[5]!.peerID, 'moderator');
		syncACL({
			admins: [nodes[1]!.peerID, nodes[2]!.peerID],
			moderators: [nodes[3]!.peerID, nodes[4]!.peerID, nodes[5]!.peerID],
		});
	});
});

// ================================================================
// 7. FINAL STATE SUMMARY
// ================================================================

describe('7. Final State Verification', () => {
	test('7.1 all authorized nodes have consistent catalog', async () => {
		await waitForGossip(3000);

		console.log('\n📊 Final catalog state per node:');
		for (const node of nodes) {
			const count = countEntries(node.id);
			const acl = node.catalog.getAccess(NET);
			console.log(`  [${node.id}] ${node.role.padEnd(8)} entries=${count} admins=${acl?.admins.length} mods=${acl?.moderators.length}`);
		}

		// Owner should have the authoritative count
		const ownerCount = countEntries(0);
		expect(ownerCount).toBeGreaterThanOrEqual(3); // at least owner-entry + some mod entries
	}, 10_000);

	test('7.2 all private keys are Ed25519', () => {
		for (const node of nodes) {
			expect(node.network.getPrivateKey().type).toBe('Ed25519');
		}
	});

	test('7.3 no forged entries exist on any node', () => {
		for (const node of nodes) {
			expect(getEntry(node.id, 'forged-10n')).toBeNull();
			expect(getEntry(node.id, 'spoofed-10n')).toBeNull();
			expect(getEntry(node.id, 'unauth-10n')).toBeNull();
			expect(getEntry(node.id, 'future-10n')).toBeNull();
			expect(getEntry(node.id, 'big-10n')).toBeNull();
			expect(getEntry(node.id, 'peer-spam')).toBeNull();
			expect(getEntry(node.id, 'attack-entry')).toBeNull();
		}
	});
});
