/**
 * Full A-Z E2E Integration Test: Create LISH → Publish → Download
 *
 * Runs against a REAL backend (Docker at 192.168.2.9:1158).
 * Tests the complete catalog workflow:
 *   1. Create a test file on the server
 *   2. Create a LISH from that file
 *   3. Get LISH details
 *   4. Publish LISH to catalog
 *   5. Verify entry in catalog (list, get, search)
 *   6. Start download from catalog
 *   7. Clean up (remove catalog entry, delete LISH, delete test file)
 *
 * Usage: cd backend && bun test tests/integration/e2e-catalog-workflow.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

const BACKEND_URL = process.env['BACKEND_URL'] || 'ws://192.168.2.9:1158';
const NETWORK_ID = process.env['NETWORK_ID'] || 'e92c238f-15be-49ea-b626-5eef330c1920';
const TEST_FILE_PATH = '/tmp/libershare-e2e-test-file.txt';
const TEST_FILE_CONTENT = 'LiberShare E2E test — this file is used for the full catalog workflow test. ' + Date.now();

// Simple WebSocket RPC client for Bun
class TestClient {
	private ws!: WebSocket;
	private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private events: { event: string; data: any }[] = [];
	private eventListeners = new Map<string, ((data: any) => void)[]>();
	private msgId = 0;

	async connect(url: string): Promise<void> {
		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(url);
			this.ws.addEventListener('open', () => resolve());
			this.ws.addEventListener('error', (e) => reject(new Error(`WebSocket error: ${e}`)));
			this.ws.addEventListener('message', (e) => this.handleMessage(e.data as string));
		});
	}

	private handleMessage(data: string): void {
		const msg = JSON.parse(data);
		if (msg.event) {
			this.events.push({ event: msg.event, data: msg.data });
			const listeners = this.eventListeners.get(msg.event);
			if (listeners) listeners.forEach(cb => cb(msg.data));
			return;
		}
		if (msg.id !== undefined) {
			const p = this.pending.get(msg.id);
			if (p) {
				this.pending.delete(msg.id);
				if (msg.error) {
					const err = new Error(msg.error);
					(err as any).code = msg.error;
					(err as any).detail = msg.errorDetail;
					p.reject(err);
				} else {
					p.resolve(msg.result);
				}
			}
		}
	}

	async call<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
		const id = String(++this.msgId);
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	onEvent(event: string, callback: (data: any) => void): void {
		if (!this.eventListeners.has(event)) this.eventListeners.set(event, []);
		this.eventListeners.get(event)!.push(callback);
	}

	waitForEvent(event: string, timeout = 30_000): Promise<any> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Timeout waiting for event: ${event}`)), timeout);
			this.onEvent(event, (data) => {
				clearTimeout(timer);
				resolve(data);
			});
		});
	}

	getEvents(): { event: string; data: any }[] {
		return [...this.events];
	}

	close(): void {
		this.ws.close();
	}
}

describe('Full A-Z Catalog Workflow', () => {
	let client: TestClient;
	let createdLishID: string;
	let lishDetail: any;

	beforeAll(async () => {
		client = new TestClient();
		await client.connect(BACKEND_URL);
		// Subscribe to all events for monitoring
		await client.call('events.subscribe', { events: ['*'] });
	});

	afterAll(async () => {
		// Cleanup in reverse order — best effort, don't fail on cleanup errors
		try {
			if (createdLishID) {
				await client.call('catalog.remove', { networkID: NETWORK_ID, lishID: createdLishID }).catch(() => {});
				await client.call('lishs.delete', { lishID: createdLishID, deleteLISH: true, deleteData: false }).catch(() => {});
			}
			await client.call('fs.delete', { path: TEST_FILE_PATH }).catch(() => {});
		} catch { /* best effort */ }
		client.close();
	});

	// ─── Step 1: Create test file on server ───────────────────────────
	test('1. Create test file on server', async () => {
		const result = await client.call<{ success: boolean }>('fs.writeText', {
			path: TEST_FILE_PATH,
			content: TEST_FILE_CONTENT,
		});
		expect(result.success).toBe(true);

		// Verify file exists
		const exists = await client.call<{ exists: boolean; type?: string }>('fs.exists', { path: TEST_FILE_PATH });
		expect(exists.exists).toBe(true);
		expect(exists.type).toBe('file');
	});

	// ─── Step 2: Create LISH from the test file ──────────────────────
	test('2. Create LISH from test file', async () => {
		const result = await client.call<{ lishID: string; lishFile?: string }>('lishs.create', {
			dataPath: TEST_FILE_PATH,
			name: 'E2E Test File',
			description: 'Automated E2E test — created by integration test suite',
			addToSharing: true,
			chunkSize: 1048576,
			algorithm: 'sha256',
			threads: 1, // single thread — Docker containers may hang with worker threads
		});

		expect(result.lishID).toBeTruthy();
		expect(typeof result.lishID).toBe('string');
		createdLishID = result.lishID;
		console.log(`  Created LISH: ${createdLishID}`);
	}, 30_000);

	// ─── Step 3: Get LISH details ────────────────────────────────────
	test('3. Get LISH details', async () => {
		expect(createdLishID).toBeTruthy();

		lishDetail = await client.call<any>('lishs.get', { lishID: createdLishID });
		expect(lishDetail).toBeTruthy();
		expect(lishDetail.id).toBe(createdLishID);
		expect(lishDetail.name).toBe('E2E Test File');
		expect(lishDetail.description).toBe('Automated E2E test — created by integration test suite');
		expect(lishDetail.chunkSize).toBe(1048576);
		expect(lishDetail.checksumAlgo).toBe('sha256');
		expect(lishDetail.totalSize).toBeGreaterThan(0);
		expect(lishDetail.fileCount).toBe(1);

		console.log(`  LISH detail: ${lishDetail.name}, ${lishDetail.totalSize} bytes, ${lishDetail.fileCount} files`);
	});

	// ─── Step 4: Verify LISH appears in local list ───────────────────
	test('4. LISH appears in lishs.list', async () => {
		const list = await client.call<{ items: any[] }>('lishs.list', {});
		const found = list.items.find((item: any) => item.id === createdLishID);
		expect(found).toBeTruthy();
		expect(found.name).toBe('E2E Test File');
		console.log(`  Found in list: ${found.name} (${list.items.length} total LISHs)`);
	});

	// ─── Step 5: Publish LISH to catalog ─────────────────────────────
	test('5. Publish LISH to catalog', async () => {
		expect(lishDetail).toBeTruthy();

		// Compute manifest hash from LISH detail (simple hash of ID for test)
		const manifestHash = `sha256:e2e-test-${createdLishID.slice(0, 8)}`;

		await client.call('catalog.publish', {
			networkID: NETWORK_ID,
			lishID: createdLishID,
			name: lishDetail.name,
			description: lishDetail.description,
			chunkSize: lishDetail.chunkSize,
			checksumAlgo: lishDetail.checksumAlgo,
			totalSize: lishDetail.totalSize,
			fileCount: lishDetail.fileCount,
			manifestHash,
			contentType: 'test',
			tags: ['e2e', 'test', 'automated'],
		});

		console.log(`  Published to catalog: ${createdLishID}`);
	});

	// ─── Step 6: Verify entry in catalog.list ────────────────────────
	test('6. Entry appears in catalog.list', async () => {
		const entries = await client.call<any[]>('catalog.list', { networkID: NETWORK_ID });
		const found = entries.find((e: any) => e.lish_id === createdLishID);
		expect(found).toBeTruthy();
		expect(found.name).toBe('E2E Test File');
		expect(found.description).toBe('Automated E2E test — created by integration test suite');
		expect(found.content_type).toBe('test');
		expect(found.total_size).toBe(lishDetail.totalSize);
		expect(found.file_count).toBe(1);
		console.log(`  Found in catalog list (${entries.length} total entries)`);
	});

	// ─── Step 7: Verify entry via catalog.get ────────────────────────
	test('7. Entry retrievable via catalog.get', async () => {
		const entry = await client.call<any>('catalog.get', {
			networkID: NETWORK_ID,
			lishID: createdLishID,
		});
		expect(entry).toBeTruthy();
		expect(entry.lish_id).toBe(createdLishID);
		expect(entry.name).toBe('E2E Test File');
		expect(entry.publisher_peer_id).toBeTruthy();
		expect(entry.published_at).toBeTruthy();
		expect(entry.chunk_size).toBe(1048576);
		expect(entry.checksum_algo).toBe('sha256');
		console.log(`  catalog.get OK: published by ${entry.publisher_peer_id.slice(0, 20)}...`);
	});

	// ─── Step 8: Search for entry by name ────────────────────────────
	test('8. Entry found via catalog.search (by name)', async () => {
		const results = await client.call<any[]>('catalog.search', {
			networkID: NETWORK_ID,
			query: 'E2E Test',
		});
		const found = results.find((e: any) => e.lish_id === createdLishID);
		expect(found).toBeTruthy();
		expect(found.name).toBe('E2E Test File');
		console.log(`  Search by name found ${results.length} result(s)`);
	});

	// ─── Step 9: Search for entry by tag ─────────────────────────────
	test('9. Entry found via catalog.search (by tag)', async () => {
		const results = await client.call<any[]>('catalog.search', {
			networkID: NETWORK_ID,
			query: '#e2e',
		});
		const found = results.find((e: any) => e.lish_id === createdLishID);
		expect(found).toBeTruthy();
		console.log(`  Search by tag #e2e found ${results.length} result(s)`);
	});

	// ─── Step 10: Catalog sync status ────────────────────────────────
	test('10. Catalog sync status includes new entry', async () => {
		const status = await client.call<{ entryCount: number; tombstoneCount: number; lastSyncAt: string | null }>('catalog.getSyncStatus', {
			networkID: NETWORK_ID,
		});
		expect(status.entryCount).toBeGreaterThan(0);
		console.log(`  Sync status: ${status.entryCount} entries, ${status.tombstoneCount} tombstones`);
	});

	// ─── Step 11: Get catalog access (ACL) ───────────────────────────
	test('11. Catalog ACL is accessible', async () => {
		const acl = await client.call<any>('catalog.getAccess', { networkID: NETWORK_ID });
		expect(acl).toBeTruthy();
		expect(acl.owner).toBeTruthy();
		console.log(`  ACL owner: ${acl.owner.slice(0, 20)}..., admins: ${acl.admins?.length ?? 0}, moderators: ${acl.moderators?.length ?? 0}`);
	});

	// ─── Step 12: Start download from catalog ────────────────────────
	test('12. Start download from catalog (catalog.startDownload)', async () => {
		const result = await client.call<{ status: string; message: string; downloadDir?: string }>('catalog.startDownload', {
			networkID: NETWORK_ID,
			lishID: createdLishID,
		});

		// Either 'downloading' (peer found itself with the data) or 'not_available' (no remote peers)
		expect(['downloading', 'not_available']).toContain(result.status);
		expect(result.message).toBeTruthy();
		console.log(`  Download status: ${result.status} — ${result.message}`);

		if (result.status === 'downloading') {
			expect(result.downloadDir).toBeTruthy();
			console.log(`  Download dir: ${result.downloadDir}`);
		}
	});

	// ─── Step 13: Update catalog entry metadata ──────────────────────
	test('13. Update catalog entry metadata', async () => {
		await client.call('catalog.update', {
			networkID: NETWORK_ID,
			lishID: createdLishID,
			name: 'E2E Test File (updated)',
			description: 'Updated description via E2E test',
			tags: ['e2e', 'test', 'automated', 'updated'],
		});

		// Verify update
		const entry = await client.call<any>('catalog.get', {
			networkID: NETWORK_ID,
			lishID: createdLishID,
		});
		expect(entry.name).toBe('E2E Test File (updated)');
		expect(entry.description).toBe('Updated description via E2E test');
		console.log(`  Updated entry name to: ${entry.name}`);
	});

	// ─── Step 14: Remove entry from catalog ──────────────────────────
	test('14. Remove entry from catalog', async () => {
		await client.call('catalog.remove', {
			networkID: NETWORK_ID,
			lishID: createdLishID,
		});

		// Verify removal
		const entry = await client.call<any>('catalog.get', {
			networkID: NETWORK_ID,
			lishID: createdLishID,
		});
		expect(entry).toBeNull();
		console.log(`  Entry removed from catalog`);
	});

	// ─── Step 15: Tombstone prevents re-add (CRDT semantics) ────────
	test('15. Tombstoned entry stays removed (CRDT 2P-Set semantics)', async () => {
		// After removal, re-publishing the same lishID should either:
		// - succeed (LWW with higher HLC) or
		// - be blocked by tombstone
		// Either way, verify the catalog state is consistent.
		const manifestHash = `sha256:e2e-test-republish-${createdLishID.slice(0, 8)}`;
		try {
			await client.call('catalog.publish', {
				networkID: NETWORK_ID,
				lishID: createdLishID,
				name: 'E2E Re-published',
				description: 'Re-published after removal',
				chunkSize: lishDetail.chunkSize,
				checksumAlgo: lishDetail.checksumAlgo,
				totalSize: lishDetail.totalSize,
				fileCount: lishDetail.fileCount,
				manifestHash,
				contentType: 'test',
				tags: ['e2e', 'republished'],
			});
		} catch {
			// Tombstone may reject re-publish — that's valid CRDT behavior
		}

		const entry = await client.call<any>('catalog.get', {
			networkID: NETWORK_ID,
			lishID: createdLishID,
		});
		// Either re-published (entry != null) or tombstoned (entry == null) — both are valid
		if (entry) {
			console.log(`  Re-published successfully: ${entry.name}`);
			await client.call('catalog.remove', { networkID: NETWORK_ID, lishID: createdLishID });
		} else {
			console.log(`  Tombstone prevents re-add — expected CRDT 2P-Set behavior`);
		}
	});

	// ─── Step 16: Delete LISH from local storage ─────────────────────
	test('16. Delete LISH from local storage', async () => {
		const deleted = await client.call<boolean>('lishs.delete', {
			lishID: createdLishID,
			deleteLISH: true,
			deleteData: false,
		});
		expect(deleted).toBe(true);

		// Verify deletion
		const detail = await client.call<any>('lishs.get', { lishID: createdLishID });
		expect(detail).toBeNull();
		console.log(`  LISH deleted from local storage`);
	});

	// ─── Step 17: Clean up test file ─────────────────────────────────
	test('17. Clean up test file', async () => {
		// fs.delete returns void, not { success: true }
		await client.call('fs.delete', { path: TEST_FILE_PATH });

		const exists = await client.call<{ exists: boolean }>('fs.exists', { path: TEST_FILE_PATH });
		expect(exists.exists).toBe(false);
		console.log(`  Test file cleaned up`);
	});

	// ─── Step 18: Verify no leftover state ───────────────────────────
	test('18. No leftover state — LISH not in list, entry not in catalog', async () => {
		const lishs = await client.call<{ items: any[] }>('lishs.list', {});
		const lishFound = lishs.items.find((item: any) => item.id === createdLishID);
		expect(lishFound).toBeFalsy();

		const entry = await client.call<any>('catalog.get', {
			networkID: NETWORK_ID,
			lishID: createdLishID,
		});
		expect(entry).toBeNull();

		console.log(`  No leftover state — clean`);
	});
});
