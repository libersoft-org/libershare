import { type CatalogManager } from '../catalog/catalog-manager.ts';
import { type Networks } from '../lishnet/lishnets.ts';
import { type DataServer } from '../lish/data-server.ts';
import { Downloader } from '../protocol/downloader.ts';
import { type IStoredLISH, type HashAlgorithm, CodedError, ErrorCodes } from '@shared';
import { Utils } from '../utils.ts';
import { join } from 'path';
import type { CatalogEntryRow, CatalogACLRow } from '../db/catalog.ts';

const assert = Utils.assertParams;

export interface StartDownloadResult {
	status: 'downloading' | 'not_available';
	message: string;
	downloadDir?: string;
}

export interface CatalogHandlers {
	list: (p: { networkID: string; limit?: number }) => CatalogEntryRow[];
	get: (p: { networkID: string; lishID: string }) => CatalogEntryRow | null;
	search: (p: { networkID: string; query: string; limit?: number }) => CatalogEntryRow[];
	publish: (p: {
		networkID: string; lishID: string; name?: string; description?: string;
		chunkSize: number; checksumAlgo: string; totalSize: number; fileCount: number;
		manifestHash: string; contentType?: string; tags?: string[];
	}) => Promise<void>;
	update: (p: { networkID: string; lishID: string; name?: string; description?: string; contentType?: string; tags?: string[] }) => Promise<void>;
	remove: (p: { networkID: string; lishID: string }) => Promise<void>;
	getAccess: (p: { networkID: string }) => CatalogACLRow | null;
	grantRole: (p: { networkID: string; delegatee: string; role: 'admin' | 'moderator' }) => Promise<void>;
	revokeRole: (p: { networkID: string; delegatee: string; role: 'admin' | 'moderator' }) => Promise<void>;
	getSyncStatus: (p: { networkID: string }) => { entryCount: number; tombstoneCount: number; lastSyncAt: string | null };
	startDownload: (p: { networkID: string; lishID: string }, client: any) => Promise<StartDownloadResult>;
}

type EmitFn = (client: any, event: string, data: any) => void;

export interface CatalogHandlerDeps {
	networks: Networks;
	dataServer: DataServer;
	dataDir: string;
	emit: EmitFn;
}

export function initCatalogHandlers(catalogManager: CatalogManager, deps?: CatalogHandlerDeps): CatalogHandlers {
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
		async startDownload(p, client): Promise<StartDownloadResult> {
			assert(p, ['networkID', 'lishID']);
			const entry = catalogManager.get(p.networkID, p.lishID);
			if (!entry) {
				return { status: 'not_available', message: 'Entry not found in catalog' };
			}
			if (!deps) {
				return { status: 'not_available', message: 'Download infrastructure not available' };
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
				await downloader.initFromManifest(stubManifest);

				// Emit progress events to frontend
				downloader.setProgressCallback(info => {
					deps.emit(client, 'transfer.download:progress', {
						lishID: entry.lish_id,
						downloadedChunks: info.downloadedChunks,
						totalChunks: info.totalChunks,
						peers: info.peers,
					});
				});

				// Start async download
				downloader
					.download()
					.then(() => deps.emit(client, 'transfer.download:complete', { downloadDir, lishID: entry.lish_id, name: entry.name }))
					.catch(err => {
						if (err instanceof CodedError) deps.emit(client, 'transfer.download:error', { error: err.code, errorDetail: err.detail, lishID: entry.lish_id });
						else deps.emit(client, 'transfer.download:error', { error: ErrorCodes.DOWNLOAD_ERROR, errorDetail: err.message, lishID: entry.lish_id });
					});

				return {
					status: 'downloading',
					message: `Download started for "${entry.name}". Looking for peers with the file...`,
					downloadDir,
				};
			} catch (err: any) {
				return {
					status: 'not_available',
					message: `Cannot start download: ${err.message}`,
				};
			}
		},
	};
}
