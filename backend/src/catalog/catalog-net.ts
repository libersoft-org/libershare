import type { Database } from 'bun:sqlite';
import type { Stream } from '@libp2p/interface';
import { encode as lpEncode, decode as lpDecode } from 'it-length-prefixed';
import { Uint8ArrayList } from 'uint8arraylist';
import { type CatalogManager } from './catalog-manager.ts';
import { SYNC_PROTOCOL, buildSyncResponse, applySyncResponse, encodeSyncRequest, decodeSyncRequest, encodeSyncResponse, decodeSyncResponse, type SyncRequest } from './catalog-sync.ts';

/**
 * Dependencies injected by the owner (Networks). Network access goes through
 * narrow function fields so CatalogNet never holds the libp2p node directly;
 * the catalog manager is a lazy accessor because it is wired after construction.
 */
export interface CatalogNetDeps {
	readonly db: Database;
	readonly getCatalogManager: () => CatalogManager | null;
	readonly subscribe: (topic: string, handler: (msg: Record<string, any>, from?: string) => void | Promise<void>) => Promise<void>;
	readonly registerStreamHandler: (protocol: string, handler: (stream: Stream) => Promise<void>) => Promise<void>;
	readonly dialProtocolByPeerId: (peerID: string, protocol: string) => Promise<{ stream: Stream }>;
	readonly getTopicPeers: (networkID: string) => string[];
}

/**
 * Network-facing side of the catalog: GossipSub live-op ingestion, the
 * bilateral sync protocol handler, and outbound catch-up sync requests.
 * Extracted from Networks so lishnet management stays free of catalog wire
 * format concerns (mirrors the Downloader → engines composition pattern).
 */
export class CatalogNet {
	private readonly deps: CatalogNetDeps;
	private syncProtocolRegistered = false;

	constructor(deps: CatalogNetDeps) {
		this.deps = deps;
	}

	/**
	 * Register the live-op GossipSub handler for a joined network, register the
	 * bilateral sync protocol handler (once per node), then request catch-up
	 * sync from currently connected topic peers.
	 */
	async attach(networkID: string): Promise<void> {
		await this.deps.subscribe(`lish/${networkID}`, async (msg: Record<string, any>) => {
			if (msg['type'] === 'catalog_op' && this.deps.getCatalogManager()) {
				if (msg['version'] !== undefined && msg['version'] !== 1) return;
				try {
					await this.deps.getCatalogManager()!.applyRemoteOp(networkID, msg as any);
				} catch (err) {
					console.warn(`[Catalog] Error applying remote op for ${networkID}:`, (err as Error).message);
				}
			}
		});

		if (!this.syncProtocolRegistered) {
			this.syncProtocolRegistered = true;
			await this.deps.registerStreamHandler(SYNC_PROTOCOL, async stream => this.handleSyncStream(stream));
			console.log(`✓ Registered ${SYNC_PROTOCOL} protocol handler`);
		}

		this.requestSync(networkID);
	}

	/** Serve one inbound bilateral sync request: decode → build delta response → send. */
	private async handleSyncStream(stream: Stream): Promise<void> {
		try {
			const decoder = lpDecode(stream);
			const msg = await decoder.next();
			if (msg.done || !msg.value) {
				await stream.close();
				return;
			}
			const raw = msg.value instanceof Uint8ArrayList ? msg.value.subarray() : msg.value;
			const req = decodeSyncRequest(new Uint8Array(raw));
			console.log(`[CatalogSync] Received sync request for ${req.networkID} since ${req.sinceHlcWall}`);
			const response = buildSyncResponse(this.deps.db, req.networkID, req.sinceHlcWall);
			console.log(`[CatalogSync] Sending ${response.operations.length} operations, ${response.entryCount} entries`);
			const encoded = encodeSyncResponse(response);
			for await (const chunk of lpEncode([encoded])) stream.send(chunk);
			await stream.close();
		} catch (err) {
			console.warn('[CatalogSync] Error handling sync request:', (err as Error).message);
			stream.abort(err instanceof Error ? err : new Error(String(err)));
		}
	}

	/** Request catch-up sync from connected topic peers; one successful peer is enough. */
	private async requestSync(networkID: string): Promise<void> {
		const catalogManager = this.deps.getCatalogManager();
		if (!catalogManager) return;
		const peers = this.deps.getTopicPeers(networkID);
		if (peers.length === 0) {
			// No peers yet — retry after a delay
			setTimeout(() => this.requestSync(networkID), 5000);
			return;
		}
		for (const peerID of peers) {
			try {
				console.log(`[CatalogSync] Requesting sync from peer ${peerID.slice(0, 20)}...`);
				const { stream } = await this.deps.dialProtocolByPeerId(peerID, SYNC_PROTOCOL);
				const req: SyncRequest = {
					command: 'catalog_sync_req',
					requestID: crypto.randomUUID(),
					networkID,
					sinceHlcWall: 0, // full sync
				};
				for await (const chunk of lpEncode([encodeSyncRequest(req)])) stream.send(chunk);
				const decoder = lpDecode(stream);
				const msg = await decoder.next();
				if (!msg.done && msg.value) {
					const raw = msg.value instanceof Uint8ArrayList ? msg.value.subarray() : msg.value;
					const response = decodeSyncResponse(new Uint8Array(raw));
					const applied = await applySyncResponse(this.deps.db, networkID, response);
					console.log(`[CatalogSync] Applied ${applied}/${response.operations.length} ops from peer (${response.entryCount} entries, ${response.tombstoneCount} tombstones)`);
					if (applied > 0) {
						catalogManager.emitSyncComplete(networkID, applied);
					}
				}
				await stream.close();
				break; // one successful sync is enough
			} catch (err) {
				console.warn(`[CatalogSync] Failed to sync from peer ${peerID.slice(0, 20)}:`, (err as Error).message);
			}
		}
	}
}
