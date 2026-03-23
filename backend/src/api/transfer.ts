import { type Networks } from '../lishnet/lishnets.ts';
import { type DataServer } from '../lish/data-server.ts';
import { type DownloadResponse, CodedError, ErrorCodes } from '@shared';
import { Downloader } from '../protocol/downloader.ts';
import { getActiveUploads, disableUpload, enableUpload, getEnabledUploads, isUploadDisabled } from '../protocol/lish-protocol.ts';
import { join } from 'path';
import { isBusy, getBusyReason } from './busy.ts';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;
type EmitFn = (client: any, event: string, data: any) => void;
type BroadcastFn = (event: string, data: any) => void;

interface ActiveTransfer {
	lishID: string;
	type: 'downloading' | 'uploading' | 'upload-disabled' | 'upload-enabled' | 'download-enabled';
	peers: number;
	bytesPerSecond: number;
}

interface TransferHandlers {
	download: (p: { networkID: string; lishPath: string }, client: any) => Promise<DownloadResponse>;
	disableDownload: (p: { lishID: string }) => { success: boolean };
	enableDownload: (p: { lishID: string }, client?: any) => Promise<{ success: boolean }>;
	disableUpload: (p: { lishID: string }) => { success: boolean };
	enableUpload: (p: { lishID: string }) => { success: boolean };
	getActiveTransfers: () => ActiveTransfer[];
}

type PersistDownloadFn = (lishID: string, enabled: boolean) => void;
let downloadEnabledLishs = new Set<string>();
let persistDownloadEnabled: PersistDownloadFn | null = null;

export function initDownloadState(enabled: Set<string>, persistFn: PersistDownloadFn): void {
	downloadEnabledLishs = enabled;
	persistDownloadEnabled = persistFn;
}

export function initTransferHandlers(networks: Networks, dataServer: DataServer, dataDir: string, emit: EmitFn, broadcast?: BroadcastFn): TransferHandlers {
	const activeDownloaders = new Map<string, Downloader>();

	async function download(p: { networkID: string; lishPath: string }, client: any): Promise<DownloadResponse> {
		assert(p, ['networkID', 'lishPath']);
		const network = networks.getRunningNetwork();
		const downloadDir = join(dataDir, 'downloads', Date.now().toString());
		const downloader = new Downloader(downloadDir, network, dataServer, p.networkID);
		await downloader.init(p.lishPath);
		const lishID = downloader.getLISHID();
		activeDownloaders.set(lishID, downloader);

		const send = broadcast ?? ((event: string, data: any) => emit(client, event, data));

		downloader.setProgressCallback?.((info: { downloadedChunks: number; totalChunks: number; peers: number; bytesPerSecond: number }) => {
			send('transfer.download:progress', { lishID, ...info });
		});

		downloader
			.download()
			.then(() => {
				activeDownloaders.delete(lishID);
				send('transfer.download:complete', { downloadDir, lishID });
			})
			.catch(err => {
				activeDownloaders.delete(lishID);
				if (err instanceof CodedError) send('transfer.download:error', { error: err.code, errorDetail: err.detail, lishID });
				else send('transfer.download:error', { error: ErrorCodes.DOWNLOAD_ERROR, errorDetail: err.message, lishID });
			});
		return { downloadDir };
	}

	function disableDownload(p: { lishID: string }): { success: boolean } {
		assert(p, ['lishID']);
		downloadEnabledLishs.delete(p.lishID);
		persistDownloadEnabled?.(p.lishID, false);
		const dl = activeDownloaders.get(p.lishID);
		if (dl) dl.pause();
		const send = broadcast ?? (() => {});
		send('transfer.download:disabled', { lishID: p.lishID });
		return { success: true };
	}

	async function enableDownload(p: { lishID: string }, client?: any): Promise<{ success: boolean }> {
		assert(p, ['lishID']);
		if (isBusy(p.lishID)) return { success: false };
		downloadEnabledLishs.add(p.lishID);
		persistDownloadEnabled?.(p.lishID, true);
		const dl = activeDownloaders.get(p.lishID);
		if (dl) {
			dl.resume();
			const send = broadcast ?? (() => {});
			send('transfer.download:enabled', { lishID: p.lishID });
			return { success: true };
		}
		// No active downloader — start a new download if LISH exists in dataServer
		const lish = dataServer.get(p.lishID);
		if (!lish) return { success: false };
		const missing = dataServer.getMissingChunks(p.lishID);
		if (missing.length === 0) return { success: false }; // already complete
		try {
			const network = networks.getRunningNetwork();
			const joinedNetworks = networks.getEnabled().map(n => n.networkID);
			if (joinedNetworks.length === 0) return { success: false };
			const downloadDir = lish.directory ?? join(dataDir, 'downloads', Date.now().toString());
			// Try all joined networks — peers may be on any of them
			const downloader = new Downloader(downloadDir, network, dataServer, joinedNetworks);
			await downloader.initFromManifest(lish);
			activeDownloaders.set(p.lishID, downloader);
			const send = broadcast ?? ((event: string, data: any) => emit(client, event, data));
			downloader.setProgressCallback?.((info: { downloadedChunks: number; totalChunks: number; peers: number; bytesPerSecond: number }) => {
				send('transfer.download:progress', { lishID: p.lishID, ...info });
			});
			downloader.download()
				.then(() => { activeDownloaders.delete(p.lishID); send('transfer.download:complete', { downloadDir, lishID: p.lishID }); })
				.catch(err => { activeDownloaders.delete(p.lishID); send('transfer.download:error', { error: err.message, lishID: p.lishID }); });
			send('transfer.download:enabled', { lishID: p.lishID });
			return { success: true };
		} catch (err) {
			console.error(`[Transfer] Failed to enable download for ${p.lishID}:`, err);
			return { success: false };
		}
	}

	function getActiveTransfers(): ActiveTransfer[] {
		const transfers: ActiveTransfer[] = [];
		const enabled = getEnabledUploads();
		// Active downloads
		for (const [lishID, dl] of activeDownloaders) {
			transfers.push({ lishID, type: 'downloading', peers: dl.getPeerCount?.() ?? 0, bytesPerSecond: 0 });
		}
		// Active uploads
		for (const [lishID, info] of getActiveUploads()) {
			if (!enabled.has(lishID)) {
				transfers.push({ lishID, type: 'upload-disabled', peers: 0, bytesPerSecond: 0 });
			} else {
				const now = Date.now();
				const samples = info.speedSamples.filter(s => s.time > now - 10000);
				const windowBytes = samples.reduce((sum, s) => sum + s.bytes, 0);
				const windowSec = samples.length > 1 ? (now - samples[0]!.time) / 1000 : (now - info.startTime) / 1000;
				const bytesPerSecond = windowSec > 0.1 ? Math.round(windowBytes / windowSec) : 0;
				transfers.push({ lishID, type: 'uploading', peers: info.peers, bytesPerSecond });
			}
		}
		// Enabled uploads not actively uploading
		const reported = new Set(transfers.map(t => t.lishID));
		for (const lishID of enabled) {
			if (!reported.has(lishID)) {
				transfers.push({ lishID, type: 'upload-enabled', peers: 0, bytesPerSecond: 0 });
			}
		}
		// Enabled downloads not actively downloading
		for (const lishID of downloadEnabledLishs) {
			if (!reported.has(lishID) && !activeDownloaders.has(lishID)) {
				transfers.push({ lishID, type: 'download-enabled', peers: 0, bytesPerSecond: 0 });
			}
		}
		return transfers;
	}

	function disableUploadHandler(p: { lishID: string }): { success: boolean } {
		assert(p, ['lishID']);
		disableUpload(p.lishID);
		return { success: true };
	}

	function enableUploadHandler(p: { lishID: string }): { success: boolean } {
		assert(p, ['lishID']);
		if (isBusy(p.lishID)) return { success: false };
		enableUpload(p.lishID);
		return { success: true };
	}

	// Auto-resume downloads that were enabled before restart
	setTimeout(() => {
		for (const lishID of downloadEnabledLishs) {
			if (!activeDownloaders.has(lishID) && !isBusy(lishID)) {
				console.log(`[Auto-resume] Resuming download for ${lishID.slice(0, 8)}...`);
				enableDownload({ lishID }).catch(() => {});
			}
		}
	}, 3000);

	return { download, disableDownload, enableDownload, disableUpload: disableUploadHandler, enableUpload: enableUploadHandler, getActiveTransfers };
}
