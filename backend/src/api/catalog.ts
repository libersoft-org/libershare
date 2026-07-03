import { type CatalogManager } from '../catalog/catalog-manager.ts';
import { type Networks } from '../lishnet/lishnets.ts';
import { type DataServer } from '../lish/data-server.ts';
import { Downloader } from '../protocol/downloader.ts';
import { type IStoredLISH, type HashAlgorithm, CodedError, ErrorCodes } from '@shared';
import { Utils } from '../utils.ts';
import { join } from 'path';
import type { CatalogEntryRow, CatalogACLRow } from '../db/catalog.ts';

const assert = Utils.assertParams;

/** Result of catalog.startDownload — whether a transfer began and a user-facing message. */
export interface StartDownloadResult {
	status: 'downloading' | 'not_available';
	message: string;
	downloadDir?: string;
}

/** WebSocket API handler set for the catalog domain (dispatched by APIServer). */
export interface CatalogHandlers {
	list: (p: { networkID: string; limit?: number }) => CatalogEntryRow[];
	get: (p: { networkID: string; lishID: string }) => CatalogEntryRow | null;
	search: (p: { networkID: string; query: string; limit?: number }) => CatalogEntryRow[];
	publish: (p: { networkID: string; lishID: string; name?: string; description?: string; chunkSize: number; checksumAlgo: string; totalSize: number; fileCount: number; manifestHash: string; contentType?: string; tags?: string[] }) => Promise<void>;
	update: (p: { networkID: string; lishID: string; name?: string; description?: string; contentType?: string; tags?: string[] }) => Promise<void>;
	remove: (p: { networkID: string; lishID: string }) => Promise<void>;
	getAccess: (p: { networkID: string }) => CatalogACLRow | null;
	grantRole: (p: { networkID: string; delegatee: string; role: 'admin' | 'moderator' }) => Promise<void>;
	revokeRole: (p: { networkID: string; delegatee: string; role: 'admin' | 'moderator' }) => Promise<void>;
	getSyncStatus: (p: { networkID: string }) => { entryCount: number; tombstoneCount: number; lastSyncAt: string | null };
	startDownload: (p: { networkID: string; lishID: string }) => Promise<StartDownloadResult>;
	pauseDownload: (p: { lishID: string }) => { success: boolean };
	resumeDownload: (p: { lishID: string }) => Promise<{ success: boolean }>;
}

type EmitFn = (client: any, event: string, data: any) => void;

type BroadcastFn = (event: string, data: any) => void;

/** Download infrastructure dependencies — optional so catalog reads work without transfer wiring (tests). */
export interface CatalogHandlerDeps {
	networks: Networks;
	dataServer: DataServer;
	dataDir: string;
	emit: EmitFn;
	broadcast: BroadcastFn;
}

/** Build the catalog API handler set around a CatalogManager (+ optional download deps). */
export function initCatalogHandlers(catalogManager: CatalogManager, deps?: CatalogHandlerDeps): CatalogHandlers {
	// Track active downloaders for pause/resume — scoped per handler set so two
	// APIServer instances (tests) never share transfer state.
	const activeDownloaders = new Map<string, Downloader>();
	return {
		list(p) {
			assert(p, ['networkID']);
			return catalogManager.list(p.networkID, p.limit);
		},
		get(p) {
			assert(p, ['networkID', 'lishID']);
			return catalogManager.get(p.networkID, p.lishID);
		},
		search(p) {
			assert(p, ['networkID', 'query']);
			return catalogManager.search(p.networkID, p.query, p.limit);
		},
		async publish(p) {
			assert(p, ['networkID', 'lishID', 'chunkSize', 'checksumAlgo', 'totalSize', 'fileCount', 'manifestHash']);
			await catalogManager.publish(p.networkID, p);
		},
		async update(p) {
			assert(p, ['networkID', 'lishID']);
			const fields: { name?: string; description?: string; contentType?: string; tags?: string[] } = {};
			if (p.name !== undefined) fields.name = p.name;
			if (p.description !== undefined) fields.description = p.description;
			if (p.contentType !== undefined) fields.contentType = p.contentType;
			if (p.tags !== undefined) fields.tags = p.tags;
			await catalogManager.update(p.networkID, p.lishID, fields);
		},
		async remove(p) {
			assert(p, ['networkID', 'lishID']);
			await catalogManager.remove(p.networkID, p.lishID);
		},
		getAccess(p) {
			assert(p, ['networkID']);
			return catalogManager.getAccess(p.networkID);
		},
		async grantRole(p) {
			assert(p, ['networkID', 'delegatee', 'role']);
			await catalogManager.grantRole(p.networkID, p.delegatee, p.role);
		},
		async revokeRole(p) {
			assert(p, ['networkID', 'delegatee', 'role']);
			await catalogManager.revokeRole(p.networkID, p.delegatee, p.role);
		},
		getSyncStatus(p) {
			assert(p, ['networkID']);
			return catalogManager.getSyncStatus(p.networkID);
		},
		async startDownload(p): Promise<StartDownloadResult> {
			assert(p, ['networkID', 'lishID']);
			const entry = catalogManager.get(p.networkID, p.lishID);
			if (!entry) {
				return { status: 'not_available', message: 'Entry not found in catalog' };
			}
			if (!deps) {
				return { status: 'not_available', message: 'Download infrastructure not available' };
			}
			if (activeDownloaders.has(entry.lish_id)) {
				return { status: 'downloading', message: 'Download already in progress' };
			}

			// Build a stub LISH manifest from catalog entry metadata.
			// The downloader will broadcast "want" on GossipSub and peers with the actual
			// chunks will respond with "have" — the manifest only needs id, name, chunkSize, checksumAlgo.
			const stubManifest: IStoredLISH = {
				id: entry.lish_id,
				name: entry.name ?? entry.lish_id,
				description: entry.description ?? undefined,
				created: entry.published_at ?? new Date().toISOString(),
				chunkSize: entry.chunk_size,
				checksumAlgo: (entry.checksum_algo as HashAlgorithm) ?? 'sha256',
			};

			try {
				const network = deps.networks.getRunningNetwork();
				const downloadDir = join(deps.dataDir, 'downloads', Date.now().toString());
				const downloader = new Downloader(downloadDir, network, deps.dataServer, p.networkID);
				// Claim the slot BEFORE the first await — two concurrent startDownload
				// calls would otherwise both pass the .has() guard (TOCTOU) and spawn
				// duplicate downloaders for the same LISH.
				activeDownloaders.set(entry.lish_id, downloader);
				await downloader.initFromManifest(stubManifest);

				// Notify ALL clients when manifest is imported (LISH appears in downloads)
				downloader.setManifestImportedCallback(lishID => {
					const detail = deps.dataServer.getDetail(lishID);
					if (detail) deps.broadcast('lishs:add', detail);
				});

				// Broadcast progress to ALL connected clients
				downloader.setProgressCallback(info => {
					deps.broadcast('transfer.download:progress', {
						lishID: entry.lish_id,
						downloadedChunks: info.downloadedChunks,
						totalChunks: info.totalChunks,
						peers: info.peers,
						bytesPerSecond: info.bytesPerSecond,
					});
				});

				// Start async download — broadcast completion/error to ALL clients
				downloader
					.download()
					.then(() => {
						activeDownloaders.delete(entry.lish_id);
						deps.broadcast('transfer.download:complete', { downloadDir, lishID: entry.lish_id, name: entry.name });
					})
					.catch(err => {
						activeDownloaders.delete(entry.lish_id);
						if (err instanceof CodedError) deps.broadcast('transfer.download:error', { error: err.code, errorDetail: err.detail, lishID: entry.lish_id });
						else deps.broadcast('transfer.download:error', { error: ErrorCodes.DOWNLOAD_ERROR, errorDetail: err.message, lishID: entry.lish_id });
					});

				return {
					status: 'downloading',
					message: `Download started for "${entry.name}". Looking for peers with the file...`,
					downloadDir,
				};
			} catch (err: any) {
				// Release the slot claimed above so a later retry can start fresh.
				activeDownloaders.delete(entry.lish_id);
				return {
					status: 'not_available',
					message: `Cannot start download: ${err.message}`,
				};
			}
		},
		pauseDownload(p) {
			assert(p, ['lishID']);
			const dl = activeDownloaders.get(p.lishID);
			if (!dl) return { success: false };
			dl.disable();
			deps?.broadcast('transfer.download:paused', { lishID: p.lishID });
			return { success: true };
		},
		async resumeDownload(p) {
			assert(p, ['lishID']);
			const dl = activeDownloaders.get(p.lishID);
			if (!dl) return { success: false };
			await dl.enable();
			deps?.broadcast('transfer.download:resumed', { lishID: p.lishID });
			return { success: true };
		},
	};
}
