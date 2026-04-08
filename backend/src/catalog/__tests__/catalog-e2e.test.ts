import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Ed25519PrivateKey } from '@libp2p/interface';
import { initCatalogTables } from '../../db/catalog.ts';
import { CatalogManager } from '../catalog-manager.ts';
import { initCatalogHandlers, type CatalogHandlers } from '../../api/catalog.ts';

interface ClientData {
	subscribedEvents: Set<string>;
}

let db: Database;
let ownerKey: Ed25519PrivateKey;
let ownerPeerID: string;
let catalogManager: CatalogManager;
let handlers: CatalogHandlers;
let server: ReturnType<typeof Bun.serve<ClientData>> | null = null;
let port: number = 0;

async function call<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		const id = crypto.randomUUID();
		ws.onopen = () => {
			ws.send(JSON.stringify({ id, method, params }));
		};
		ws.onmessage = (event) => {
			const msg = JSON.parse(event.data as string);
			ws.close();
			if (msg.error) reject(new Error(msg.error));
			else resolve(msg.result as T);
		};
		ws.onerror = (e) => reject(e);
	});
}

beforeEach(async () => {
	db = new Database(':memory:');
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA foreign_keys = ON');
	initCatalogTables(db);
	ownerKey = await generateKeyPair('Ed25519');
	ownerPeerID = ownerKey.publicKey.toString();

	catalogManager = new CatalogManager({
		db,
		getPrivateKey: () => ownerKey,
		getLocalPeerID: () => ownerPeerID,
	});
	catalogManager.join('net1', ownerPeerID);

	handlers = initCatalogHandlers(catalogManager);

	// Start a simple WebSocket server
	server = Bun.serve<ClientData>({
		port: 0,
		hostname: '127.0.0.1',
		fetch(req, s) {
			const upgraded = s.upgrade(req, { data: { subscribedEvents: new Set<string>() } });
			if (upgraded) return undefined;
			return new Response('Expected WebSocket', { status: 400 });
		},
		websocket: {
			open() {},
			close() {},
			async message(ws, message) {
				const req = JSON.parse(message.toString());
				try {
					const handler = (handlers as any)[req.method.replace('catalog.', '')];
					if (!handler) {
						ws.send(JSON.stringify({ id: req.id, error: 'UNKNOWN_METHOD' }));
						return;
					}
					const result = await handler(req.params || {});
					ws.send(JSON.stringify({ id: req.id, result }));
				} catch (err: any) {
					ws.send(JSON.stringify({ id: req.id, error: err.message }));
				}
			},
		},
	});
	port = server!.port ?? 0;
});

afterEach(() => {
	server?.stop();
	server = null;
});

describe('E2E via WebSocket: Catalog API', () => {
	test('publish and list via WS', async () => {
		await call('catalog.publish', {
			networkID: 'net1',
			lishID: 'ws-1',
			name: 'WS Test Entry',
			description: 'Published via WebSocket',
			chunkSize: 1024,
			checksumAlgo: 'sha256',
			totalSize: 5000,
			fileCount: 2,
			manifestHash: 'ws-hash-1',
			contentType: 'software',
			tags: ['test', 'websocket'],
		});

		const entries = await call<any[]>('catalog.list', { networkID: 'net1' });
		expect(entries.length).toBe(1);
		expect(entries[0].name).toBe('WS Test Entry');
		expect(entries[0].total_size).toBe(5000);
	});

	test('get single entry via WS', async () => {
		await call('catalog.publish', {
			networkID: 'net1', lishID: 'ws-get',
			name: 'Get Test', chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 100, fileCount: 1, manifestHash: 'h1',
		});

		const entry = await call<any>('catalog.get', { networkID: 'net1', lishID: 'ws-get' });
		expect(entry).not.toBeNull();
		expect(entry.name).toBe('Get Test');
	});

	test('update entry via WS', async () => {
		await call('catalog.publish', {
			networkID: 'net1', lishID: 'ws-upd',
			name: 'Before Update', chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 100, fileCount: 1, manifestHash: 'h1',
		});

		await call('catalog.update', {
			networkID: 'net1', lishID: 'ws-upd',
			name: 'After Update', description: 'Updated via WS',
		});

		const entry = await call<any>('catalog.get', { networkID: 'net1', lishID: 'ws-upd' });
		expect(entry.name).toBe('After Update');
		expect(entry.description).toBe('Updated via WS');
	});

	test('remove entry via WS', async () => {
		await call('catalog.publish', {
			networkID: 'net1', lishID: 'ws-rem',
			name: 'To Remove', chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 100, fileCount: 1, manifestHash: 'h1',
		});

		await call('catalog.remove', { networkID: 'net1', lishID: 'ws-rem' });

		const entry = await call<any>('catalog.get', { networkID: 'net1', lishID: 'ws-rem' });
		expect(entry).toBeNull();
	});

	test('search via WS', async () => {
		for (const [id, name] of [['s1', 'Ubuntu Desktop'], ['s2', 'Fedora Server'], ['s3', 'Arch Linux']] as const) {
			await call('catalog.publish', {
				networkID: 'net1', lishID: id, name,
				chunkSize: 1024, checksumAlgo: 'sha256',
				totalSize: 100, fileCount: 1, manifestHash: `h-${id}`,
			});
		}

		const results = await call<any[]>('catalog.search', { networkID: 'net1', query: 'server' });
		expect(results.length).toBe(1);
		expect(results[0].name).toBe('Fedora Server');
	});

	test('getAccess via WS', async () => {
		const acl = await call<any>('catalog.getAccess', { networkID: 'net1' });
		expect(acl.owner).toBe(ownerPeerID);
		expect(acl.admins).toEqual([]);
	});

	test('grantRole and revokeRole via WS', async () => {
		const modKey = await generateKeyPair('Ed25519');
		const modPeerID = modKey.publicKey.toString();

		await call('catalog.grantRole', {
			networkID: 'net1', delegatee: modPeerID, role: 'moderator',
		});

		let acl = await call<any>('catalog.getAccess', { networkID: 'net1' });
		expect(acl.moderators).toContain(modPeerID);

		await call('catalog.revokeRole', {
			networkID: 'net1', delegatee: modPeerID, role: 'moderator',
		});

		acl = await call<any>('catalog.getAccess', { networkID: 'net1' });
		expect(acl.moderators).not.toContain(modPeerID);
	});

	test('full lifecycle via WS: publish → update → search → remove → verify gone', async () => {
		// Publish
		await call('catalog.publish', {
			networkID: 'net1', lishID: 'lifecycle',
			name: 'Lifecycle Test', description: 'Full E2E flow',
			chunkSize: 2048, checksumAlgo: 'sha256',
			totalSize: 10000, fileCount: 5, manifestHash: 'hash-life',
			contentType: 'dataset', tags: ['test', 'e2e'],
		});

		// Verify published
		let entry = await call<any>('catalog.get', { networkID: 'net1', lishID: 'lifecycle' });
		expect(entry.name).toBe('Lifecycle Test');

		// Update
		await call('catalog.update', {
			networkID: 'net1', lishID: 'lifecycle',
			name: 'Lifecycle Updated', tags: ['test', 'e2e', 'updated'],
		});

		entry = await call<any>('catalog.get', { networkID: 'net1', lishID: 'lifecycle' });
		expect(entry.name).toBe('Lifecycle Updated');

		// Search
		const found = await call<any[]>('catalog.search', { networkID: 'net1', query: 'Lifecycle' });
		expect(found.length).toBe(1);

		// Remove
		await call('catalog.remove', { networkID: 'net1', lishID: 'lifecycle' });

		// Verify gone
		const gone = await call<any>('catalog.get', { networkID: 'net1', lishID: 'lifecycle' });
		expect(gone).toBeNull();

		// Search returns nothing
		const notFound = await call<any[]>('catalog.search', { networkID: 'net1', query: 'Lifecycle' });
		expect(notFound.length).toBe(0);
	});

	test('unknown method returns error', async () => {
		await expect(call('catalog.nonexistent', {})).rejects.toThrow('UNKNOWN_METHOD');
	});

	test('multiple rapid publishes via WS', async () => {
		for (let i = 0; i < 20; i++) {
			await call('catalog.publish', {
				networkID: 'net1', lishID: `rapid-${i}`, name: `Rapid ${i}`,
				chunkSize: 1024, checksumAlgo: 'sha256',
				totalSize: i * 100, fileCount: 1, manifestHash: `h-${i}`,
			});
		}

		const entries = await call<any[]>('catalog.list', { networkID: 'net1', limit: 50 });
		expect(entries.length).toBe(20);
	});
});
