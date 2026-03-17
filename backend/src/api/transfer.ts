import { type Networks } from '../lishnet/lishnets.ts';
import { type DataServer } from '../lish/data-server.ts';
import { type DownloadResponse, CodedError, ErrorCodes } from '@shared';
import { Downloader } from '../protocol/downloader.ts';
import { getActiveUploads, pauseUpload, resumeUpload, getPausedUploads } from '../protocol/lish-protocol.ts';
import { join } from 'path';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;
type EmitFn = (client: any, event: string, data: any) => void;
type BroadcastFn = (event: string, data: any) => void;

interface ActiveTransfer {
	lishID: string;
	type: 'downloading' | 'uploading';
	peers: number;
	bytesPerSecond: number;
}

interface TransferHandlers {
	download: (p: { networkID: string; lishPath: string }, client: any) => Promise<DownloadResponse>;
	pauseDownload: (p: { lishID: string }) => { success: boolean };
	resumeDownload: (p: { lishID: string }, client?: any) => Promise<{ success: boolean }>;
	pauseUpload: (p: { lishID: string }) => { success: boolean };
	resumeUpload: (p: { lishID: string }) => { success: boolean };
	getActiveTransfers: () => ActiveTransfer[];
}

export function initTransferHandlers(networks: Networks, dataServer: DataServer, dataDir: string, emit: EmitFn, broadcast?: BroadcastFn): TransferHandlers {
	const activeDownloaders = new Map<string, Downloader>();

	async function download(p: { networkID: string; lishPath: string }, client: any): Promise<DownloadResponse> {
		assert(p, ['networkID', 'lishPath']);
		const network = networks.getRunningNetwork();
		const downloadDir = join(dataDir, 'downloads', Date.now().toString());
		const downloader = new Downloader(downloadDir, network, dataServer, p.networkID);
		await downloader.init(p.lishPath);
		const lishID = downloader.getLISHID?.() ?? p.lishPath;
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

	function pauseDownload(p: { lishID: string }): { success: boolean } {
		assert(p, ['lishID']);
		const dl = activeDownloaders.get(p.lishID);
		if (!dl) return { success: false };
		dl.pause();
		const send = broadcast ?? (() => {});
		send('transfer.download:paused', { lishID: p.lishID });
		return { success: true };
	}

	async function resumeDownload(p: { lishID: string }, client?: any): Promise<{ success: boolean }> {
		assert(p, ['lishID']);
		const dl = activeDownloaders.get(p.lishID);
		if (dl) {
			dl.resume();
			const send = broadcast ?? (() => {});
			send('transfer.download:resumed', { lishID: p.lishID });
			return { success: true };
		}
		// No active downloader — start a new download if LISH exists in dataServer
		const lish = dataServer.get(p.lishID);
		if (!lish) return { success: false };
		const missing = dataServer.getMissingChunks(p.lishID);
		if (missing.length === 0) return { success: false }; // already complete
		try {
			const network = networks.getRunningNetwork();
			const networkID = networks.getFirstJoinedNetworkID?.() ?? '';
			if (!networkID) return { success: false };
			const downloadDir = lish.directory ?? join(dataDir, 'downloads', Date.now().toString());
			const downloader = new Downloader(downloadDir, network, dataServer, networkID);
			await downloader.initFromManifest(lish);
			activeDownloaders.set(p.lishID, downloader);
			const send = broadcast ?? ((event: string, data: any) => emit(client, event, data));
			downloader.setProgressCallback?.((info: { downloadedChunks: number; totalChunks: number; peers: number; bytesPerSecond: number }) => {
				send('transfer.download:progress', { lishID: p.lishID, ...info });
			});
			downloader.download()
				.then(() => { activeDownloaders.delete(p.lishID); send('transfer.download:complete', { downloadDir, lishID: p.lishID }); })
				.catch(err => { activeDownloaders.delete(p.lishID); send('transfer.download:error', { error: err.message, lishID: p.lishID }); });
			send('transfer.download:resumed', { lishID: p.lishID });
			return { success: true };
		} catch { return { success: false }; }
	}

	function getActiveTransfers(): ActiveTransfer[] {
		const transfers: ActiveTransfer[] = [];
		// Active downloads
		for (const [lishID] of activeDownloaders) {
			transfers.push({ lishID, type: 'downloading', peers: 0, bytesPerSecond: 0 });
		}
		// Active uploads
		for (const [lishID, info] of getActiveUploads()) {
			const elapsed = (Date.now() - info.startTime) / 1000;
			const bytesPerSecond = elapsed > 0 ? Math.round(info.bytes / elapsed) : 0;
			transfers.push({ lishID, type: 'uploading', peers: info.peers, bytesPerSecond });
		}
		return transfers;
	}

	function pauseUploadHandler(p: { lishID: string }): { success: boolean } {
		assert(p, ['lishID']);
		pauseUpload(p.lishID);
		return { success: true };
	}

	function resumeUploadHandler(p: { lishID: string }): { success: boolean } {
		assert(p, ['lishID']);
		resumeUpload(p.lishID);
		return { success: true };
	}

	return { download, pauseDownload, resumeDownload, pauseUpload: pauseUploadHandler, resumeUpload: resumeUploadHandler, getActiveTransfers };
}
