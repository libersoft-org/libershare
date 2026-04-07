import { type Networks } from '../lishnet/lishnets.ts';
import { type DataServer } from '../lish/data-server.ts';
import { type DownloadResponse, CodedError, ErrorCodes } from '@shared';
import { Downloader } from '../protocol/downloader.ts';
import { getActiveUploads, disableUpload, enableUpload, getEnabledUploads } from '../protocol/lish-protocol.ts';
import { join, dirname } from 'path';
import { access, constants } from 'fs/promises';
import { isBusy } from './busy.ts';
import { ErrorRecovery } from './error-recovery.ts';
import type { Settings } from '../settings.ts';
import { Utils } from '../utils.ts';
import { setPeerEmit, startPeerEmitter, subscribePeers, unsubscribePeers, unsubscribeAllPeers } from '../protocol/peer-tracker.ts';
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
	subscribePeers: (p: { lishID: string }, client: any) => boolean;
	unsubscribePeers: (p: { lishID: string }, client: any) => boolean;
}

type PersistDownloadFn = (lishID: string, enabled: boolean) => void;
let downloadEnabledLishs = new Set<string>();
let persistDownloadEnabled: PersistDownloadFn | null = null;

export function initDownloadState(enabled: Set<string>, persistFn: PersistDownloadFn): void {
	downloadEnabledLishs = enabled;
	persistDownloadEnabled = persistFn;
}

export function getDownloadEnabledLishs(): Set<string> { return downloadEnabledLishs; }
export function isDownloadEnabled(lishID: string): boolean { return downloadEnabledLishs.has(lishID); }
export function markDownloadEnabled(lishID: string): void { downloadEnabledLishs.add(lishID); persistDownloadEnabled?.(lishID, true); }
let _activeDownloaders: Map<string, any> | null = null;
export function setActiveDownloadersRef(ref: Map<string, any>): void { _activeDownloaders = ref; }
export async function forceDisableDownload(lishID: string): Promise<void> {
	downloadEnabledLishs.delete(lishID);
	persistDownloadEnabled?.(lishID, false);
	await destroyActiveDownloader(lishID);
}

/** Destroy and remove active downloader WITHOUT changing DB flags. */
export async function destroyActiveDownloader(lishID: string): Promise<void> {
	const dl = _activeDownloaders?.get(lishID);
	if (dl) {
		await dl.destroy();
		_activeDownloaders!.delete(lishID);
	}
}

/** Remove in-memory download state without DB persist (for LISH deletion). */
export async function removeDownloadState(lishID: string): Promise<void> {
	downloadEnabledLishs.delete(lishID);
	await destroyActiveDownloader(lishID);
}

/** Stop error recovery for a LISH (call when LISH is deleted). */
let _stopRecoveryFn: ((lishID: string) => void) | null = null;
export function setStopRecoveryFn(fn: (lishID: string) => void): void { _stopRecoveryFn = fn; }
export function stopRecoveryForLISH(lishID: string): void { _stopRecoveryFn?.(lishID); }

/** Restart download for a LISH if it was enabled. Called after busy state clears. */
let _enableDownloadFn: ((p: { lishID: string }) => Promise<{ success: boolean }>) | null = null;
export function setEnableDownloadFn(fn: (p: { lishID: string }) => Promise<{ success: boolean }>): void { _enableDownloadFn = fn; }
export function restartDownloadIfEnabled(lishID: string): void {
	if (downloadEnabledLishs.has(lishID) && _enableDownloadFn) {
		_enableDownloadFn({ lishID }).catch(() => {});
	}
}

/** Enable downloading for a LISH from outside the transfer module (e.g. after import). */
export function triggerEnableDownload(lishID: string): void {
	if (_enableDownloadFn) {
		_enableDownloadFn({ lishID }).catch(() => {});
	}
}

export function initTransferHandlers(networks: Networks, dataServer: DataServer, dataDir: string, emit: EmitFn, broadcast?: BroadcastFn, settings?: Settings): TransferHandlers {
	const activeDownloaders = new Map<string, Downloader>();
	setActiveDownloadersRef(activeDownloaders);

	// Error recovery: auto-retry when IO conditions clear
	const recovery = new ErrorRecovery({
		attemptRecover: async (lishID, downloadWasEnabled, uploadWasEnabled) => {
			let ok = true;
			if (downloadWasEnabled) {
				const result = await enableDownload({ lishID });
				if (!result.success) ok = false;
			}
			if (uploadWasEnabled && ok) enableUploadHandler({ lishID });
			return ok;
		},
		broadcast: (event, data) => { broadcast?.(event, data); },
		getLISH: (lishID) => dataServer.get(lishID) ?? undefined as any,
		checkAccess: async (path) => { await access(path, constants.R_OK | constants.W_OK); },
	});

	function startRecoveryIfEnabled(lishID: string, errorCode: string, prev: { downloadEnabled: boolean; uploadEnabled: boolean }): void {
		if (settings?.get('network.autoErrorRecovery') === false) return;
		recovery.start(lishID, errorCode, prev);
	}

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
		downloader.setRetryCallback?.((info) => {
			if (info.resolved) send('transfer.download:resumed', { lishID });
			else send('transfer.download:retrying', { lishID, ...info });
		});

		downloader
			.download()
			.then(() => {
				if (activeDownloaders.get(lishID) === downloader) activeDownloaders.delete(lishID);
				send('transfer.download:complete', { downloadDir, lishID });
			})
			.catch(err => {
				if (activeDownloaders.get(lishID) === downloader) activeDownloaders.delete(lishID);
				if (err instanceof CodedError && err.code === ErrorCodes.DOWNLOAD_CANCELLED) return;
				const code = err instanceof CodedError ? err.code : ErrorCodes.DOWNLOAD_ERROR;
				const detail = err instanceof CodedError ? err.detail : err.message;
				dataServer.setError(lishID, code, detail);
				downloadEnabledLishs.delete(lishID);
				persistDownloadEnabled?.(lishID, false);
				send('transfer.download:error', { error: code, errorDetail: detail, lishID });
				startRecoveryIfEnabled(lishID, code, { downloadEnabled: true, uploadEnabled: getEnabledUploads().has(lishID) });
			});
		return { downloadDir };
	}

	function disableDownload(p: { lishID: string }): { success: boolean } {
		assert(p, ['lishID']);
		recovery.stop(p.lishID);
		downloadEnabledLishs.delete(p.lishID);
		persistDownloadEnabled?.(p.lishID, false);
		const dl = activeDownloaders.get(p.lishID);
		if (dl) dl.disable();
		const send = broadcast ?? (() => {});
		send('transfer.download:disabled', { lishID: p.lishID });
		return { success: true };
	}

	const pendingDownloads = new Set<string>();

	async function enableDownload(p: { lishID: string }, client?: any): Promise<{ success: boolean }> {
		assert(p, ['lishID']);
		if (isBusy(p.lishID)) return { success: false };
		if (pendingDownloads.has(p.lishID)) return { success: true };
		dataServer.clearError(p.lishID);
		downloadEnabledLishs.add(p.lishID);
		persistDownloadEnabled?.(p.lishID, true);
		const dl = activeDownloaders.get(p.lishID);
		if (dl) {
			await dl.enable();
			if (dl.getError()) {
				const err = dl.getError()!;
				const send = broadcast ?? ((event: string, data: any) => emit(client, event, data));
				dataServer.setError(p.lishID, err.code, err.detail);
				downloadEnabledLishs.delete(p.lishID);
				persistDownloadEnabled?.(p.lishID, false);
				if (activeDownloaders.get(p.lishID) === dl) activeDownloaders.delete(p.lishID);
				send('transfer.download:error', { error: err.code, errorDetail: err.detail, lishID: p.lishID });
				startRecoveryIfEnabled(p.lishID, err.code, { downloadEnabled: true, uploadEnabled: getEnabledUploads().has(p.lishID) });
				return { success: false };
			}
			const send = broadcast ?? (() => {});
			recovery.stop(p.lishID);
			send('transfer.download:enabled', { lishID: p.lishID });
			return { success: true };
		}
		// No active downloader — start a new download if LISH exists in dataServer
		const lish = dataServer.get(p.lishID);
		if (!lish) {
			downloadEnabledLishs.delete(p.lishID);
			persistDownloadEnabled?.(p.lishID, false);
			return { success: false };
		}
		const missing = dataServer.getMissingChunks(p.lishID);
		if (missing.length === 0) {
			const send = broadcast ?? (() => {});
			send('transfer.download:enabled', { lishID: p.lishID });
			return { success: true };
		}
		pendingDownloads.add(p.lishID);
		try {
			const network = networks.getRunningNetwork();
			const joinedNetworks = networks.getEnabled().map(n => n.networkID);
			if (joinedNetworks.length === 0) {
				downloadEnabledLishs.delete(p.lishID);
				persistDownloadEnabled?.(p.lishID, false);
				return { success: false };
			}
			const downloadDir = lish.directory ?? join(dataDir, 'downloads', Date.now().toString());
			// Pre-validate download directory (check dir itself for resume, parent for fresh)
			if (lish.directory) {
				const hasChunks = dataServer.getAllChunkCount(p.lishID) > dataServer.getMissingChunks(p.lishID).length;
				const checkPath = hasChunks ? downloadDir : dirname(downloadDir);
				try {
					await access(checkPath, constants.R_OK | constants.W_OK);
				} catch (err: any) {
					const code = err.code === 'EACCES' || err.code === 'EPERM' ? ErrorCodes.DIRECTORY_ACCESS_DENIED : ErrorCodes.IO_NOT_FOUND;
					console.warn(`[Transfer] ${p.lishID.slice(0, 8)}: download dir inaccessible (${code}): ${downloadDir}`);
					const send = broadcast ?? ((event: string, data: any) => emit(client, event, data));
					dataServer.setError(p.lishID, code, downloadDir);
					downloadEnabledLishs.delete(p.lishID);
					persistDownloadEnabled?.(p.lishID, false);
					send('transfer.download:error', { error: code, errorDetail: downloadDir, lishID: p.lishID });
					startRecoveryIfEnabled(p.lishID, code, { downloadEnabled: true, uploadEnabled: getEnabledUploads().has(p.lishID) });
					return { success: false };
				}
			}
			const downloader = new Downloader(downloadDir, network, dataServer, joinedNetworks);
			await downloader.initFromManifest(lish);
			activeDownloaders.set(p.lishID, downloader);
			const send = broadcast ?? ((event: string, data: any) => emit(client, event, data));
			downloader.setProgressCallback?.((info: { downloadedChunks: number; totalChunks: number; peers: number; bytesPerSecond: number }) => {
				send('transfer.download:progress', { lishID: p.lishID, ...info });
			});
			downloader.setRetryCallback?.((info) => {
				if (info.resolved) send('transfer.download:resumed', { lishID: p.lishID });
				else send('transfer.download:retrying', { lishID: p.lishID, ...info });
			});
			downloader.download()
				.then(() => { if (activeDownloaders.get(p.lishID) === downloader) activeDownloaders.delete(p.lishID); send('transfer.download:complete', { downloadDir, lishID: p.lishID }); })
				.catch(err => {
					if (activeDownloaders.get(p.lishID) === downloader) activeDownloaders.delete(p.lishID);
					if (err instanceof CodedError && err.code === ErrorCodes.DOWNLOAD_CANCELLED) return;
					const code = err instanceof CodedError ? err.code : ErrorCodes.DOWNLOAD_ERROR;
					const detail = err instanceof CodedError ? err.detail : err.message;
					dataServer.setError(p.lishID, code, detail);
					downloadEnabledLishs.delete(p.lishID);
					persistDownloadEnabled?.(p.lishID, false);
					send('transfer.download:error', { error: code, errorDetail: detail, lishID: p.lishID });
					startRecoveryIfEnabled(p.lishID, code, { downloadEnabled: true, uploadEnabled: getEnabledUploads().has(p.lishID) });
				});
			recovery.stop(p.lishID);
			send('transfer.download:enabled', { lishID: p.lishID });
			return { success: true };
		} catch (err: any) {
			const code = err instanceof CodedError ? err.code : ErrorCodes.DOWNLOAD_ERROR;
			const detail = err instanceof CodedError ? err.detail : err.message;
			console.error(`[Transfer] ${p.lishID.slice(0, 8)}: enableDownload failed (${code}): ${detail}`);
			dataServer.setError(p.lishID, code, detail);
			downloadEnabledLishs.delete(p.lishID);
			persistDownloadEnabled?.(p.lishID, false);
			const send = broadcast ?? (() => {});
			send('transfer.download:error', { error: code, errorDetail: detail, lishID: p.lishID });
			startRecoveryIfEnabled(p.lishID, code, { downloadEnabled: true, uploadEnabled: getEnabledUploads().has(p.lishID) });
			return { success: false };
		} finally {
			pendingDownloads.delete(p.lishID);
		}
	}

	// Register enableDownload for module-level restartDownloadIfEnabled
	setEnableDownloadFn(enableDownload);
	setStopRecoveryFn((lishID) => recovery.stop(lishID));

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
		recovery.stop(p.lishID);
		disableUpload(p.lishID);
		return { success: true };
	}

	function enableUploadHandler(p: { lishID: string }): { success: boolean } {
		assert(p, ['lishID']);
		if (isBusy(p.lishID)) return { success: false };
		recovery.stop(p.lishID);
		dataServer.clearError(p.lishID);
		enableUpload(p.lishID);
		return { success: true };
	}

	// Intercept upload error broadcasts to start recovery
	const _origBroadcast = broadcast;
	if (_origBroadcast) {
		broadcast = (event: string, data: any) => {
			_origBroadcast(event, data);
			if (event === 'transfer.upload:error' && data?.lishID && data?.error) {
				startRecoveryIfEnabled(data.lishID, data.error, {
					downloadEnabled: downloadEnabledLishs.has(data.lishID),
					uploadEnabled: true,
				});
			}
		};
	}

	// Auto-resume downloads that were enabled before restart (skip errored)
	setTimeout(() => {
		for (const lishID of downloadEnabledLishs) {
			if (!activeDownloaders.has(lishID) && !isBusy(lishID)) {
				console.log(`[Auto-resume] Resuming download for ${lishID.slice(0, 8)}...`);
				enableDownload({ lishID }).catch(err => {
					console.error(`[Auto-resume] Failed for ${lishID.slice(0, 8)}:`, err.message);
				});
			}
		}
	}, 3000);

	// Wire peer-tracker emitter
	if (emit) {
		setPeerEmit(emit);
		startPeerEmitter();
	}

	function subscribePeersHandler(p: { lishID: string }, client: any): boolean {
		assert(p, { lishID: 'string' });
		subscribePeers(client, p.lishID);
		return true;
	}

	function unsubscribePeersHandler(p: { lishID: string }, client: any): boolean {
		assert(p, { lishID: 'string' });
		unsubscribePeers(client, p.lishID);
		return true;
	}

	return { download, disableDownload, enableDownload, disableUpload: disableUploadHandler, enableUpload: enableUploadHandler, getActiveTransfers, subscribePeers: subscribePeersHandler, unsubscribePeers: unsubscribePeersHandler };
}
