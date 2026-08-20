import { type Networks } from '../lishnet/lishnets.ts';
import { type DataServer } from '../lish/data-server.ts';
import { type DownloadResponse, CodedError, ErrorCodes } from '@shared';
import { Downloader } from '../protocol/downloader.ts';
import { getActiveUploads, disableUpload, enableUpload, getEnabledUploads, setUploadRecoveryHooks, clearAllUploads } from '../protocol/lish-protocol.ts';
import { join, dirname } from 'path';
import { access, constants } from 'fs/promises';
import { isBusy } from './busy.ts';
import { ErrorRecovery } from './error-recovery.ts';
import type { Settings } from '../settings.ts';
import { Utils } from '../utils.ts';
import { setPeerEmit, startPeerEmitter, subscribePeers, unsubscribePeers, getDebugSnapshot } from '../protocol/peer-tracker.ts';
const assert = Utils.assertParams;
type EmitFn = (client: any, event: string, data: any) => void;
type BroadcastFn = (event: string, data: any) => void;

interface ActiveTransfer {
	lishID: string;
	type: 'downloading' | 'allocating' | 'uploading' | 'upload-disabled' | 'upload-enabled' | 'download-enabled';
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
	debugPeers: (p: { lishID?: string }) => ReturnType<typeof getDebugSnapshot>;
	findPeers: (p: { lishID: string }) => { success: boolean };
	/** Tear down all in-memory transfer state (factory reset). Not a WS endpoint. */
	clearAll: () => Promise<void>;
	/** Re-open transfer admission after factory-reset orchestration finishes. */
	resumeAll: () => void;
}

type PersistDownloadFn = (lishID: string, enabled: boolean) => void;
let downloadEnabledLishs = new Set<string>();
let persistDownloadEnabled: PersistDownloadFn | null = null;

export function initDownloadState(enabled: Set<string>, persistFn: PersistDownloadFn): void {
	downloadEnabledLishs = enabled;
	persistDownloadEnabled = persistFn;
}

export function getDownloadEnabledLishs(): Set<string> {
	return downloadEnabledLishs;
}
export function isDownloadEnabled(lishID: string): boolean {
	return downloadEnabledLishs.has(lishID);
}
export function markDownloadEnabled(lishID: string): void {
	downloadEnabledLishs.add(lishID);
	persistDownloadEnabled?.(lishID, true);
}
let _activeDownloaders: Map<string, any> | null = null;
let _networkSuspended: Map<string, Set<string>> | null = null;
export function setActiveDownloadersRef(ref: Map<string, any>): void {
	_activeDownloaders = ref;
}
export function setNetworkSuspendedRef(ref: Map<string, Set<string>>): void {
	_networkSuspended = ref;
}
export async function forceDisableDownload(lishID: string): Promise<void> {
	downloadEnabledLishs.delete(lishID);
	_networkSuspended?.delete(lishID);
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

/**
 * Destroy every downloader without hiding failures. Without a restore callback, successful
 * entries are removed and failed ones remain. Factory reset supplies a restore callback so
 * any partial teardown is replaced with a complete fresh runtime set before the error escapes.
 */
export async function destroyAllDownloaders<T extends Pick<Downloader, 'destroy'>>(activeDownloaders: Map<string, T>, restore?: (lishID: string, previous: T) => Promise<T>): Promise<void> {
	const previousDownloaders = [...activeDownloaders];
	const errors: unknown[] = [];
	for (const [lishID, downloader] of previousDownloaders) {
		try {
			await downloader.destroy();
			activeDownloaders.delete(lishID);
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length === 0) return;

	const restoreErrors: unknown[] = [];
	if (restore) {
		// destroy() is not reversible: even a call that throws may already have aborted the
		// downloader and disposed its handlers. Replace the whole original set so callers
		// never receive a half-live mixture after a failed reset barrier.
		for (const [lishID, previous] of previousDownloaders) {
			activeDownloaders.delete(lishID);
			try {
				activeDownloaders.set(lishID, await restore(lishID, previous));
			} catch (error) {
				restoreErrors.push(error);
			}
		}
	}

	const restoreDetail = restoreErrors.length > 0 ? `; failed to restore ${restoreErrors.length} download(s)` : '';
	throw new AggregateError([...errors, ...restoreErrors], `Failed to stop ${errors.length} active download(s)${restoreDetail}`);
}

/** Remove in-memory download state without DB persist (for LISH deletion). */
export async function removeDownloadState(lishID: string): Promise<void> {
	downloadEnabledLishs.delete(lishID);
	_networkSuspended?.delete(lishID);
	await destroyActiveDownloader(lishID);
}

/** Return only configured lishnets that are also joined by this running node. */
export function getJoinedEnabledNetworkIDs(networks: Pick<Networks, 'getEnabled' | 'isJoined'>): string[] {
	return networks
		.getEnabled()
		.filter(network => networks.isJoined(network.networkID))
		.map(network => network.networkID);
}

/** Stop error recovery for a LISH (call when LISH is deleted). */
let _stopRecoveryFn: ((lishID: string) => void) | null = null;
export function setStopRecoveryFn(fn: (lishID: string) => void): void {
	_stopRecoveryFn = fn;
}
export function stopRecoveryForLISH(lishID: string): void {
	_stopRecoveryFn?.(lishID);
}

/** Restart download for a LISH if it was enabled. Called after busy state clears. */
let _enableDownloadFn: ((p: { lishID: string }) => Promise<{ success: boolean }>) | null = null;
export function setEnableDownloadFn(fn: (p: { lishID: string }) => Promise<{ success: boolean }>): void {
	_enableDownloadFn = fn;
}
export function restartDownloadIfEnabled(lishID: string): void {
	if (downloadEnabledLishs.has(lishID) && _enableDownloadFn) {
		_enableDownloadFn({ lishID }).catch((err: any) => {
			console.error(`[Transfer] restartDownloadIfEnabled(${lishID.slice(0, 8)}) failed:`, err?.message ?? err);
		});
	}
}

/** Enable downloading for a LISH from outside the transfer module (e.g. after import). */
export function triggerEnableDownload(lishID: string): void {
	if (_enableDownloadFn) {
		_enableDownloadFn({ lishID }).catch((err: any) => {
			console.error(`[Transfer] triggerEnableDownload(${lishID.slice(0, 8)}) failed:`, err?.message ?? err);
		});
	}
}

/** What {@link LeftDownloaderDeps} the handler below needs from the transfer handlers. */
export interface LeftDownloaderDeps {
	readonly networks: Pick<Networks, 'isJoined'>;
	readonly downloadEnabledLishs: Set<string>;
	readonly networkSuspended: Map<string, Set<string>>;
	readonly activeDownloaders: Map<string, Downloader>;
	readonly recovery: Pick<ErrorRecovery, 'stop'>;
	readonly broadcast?: ((event: string, data: any) => void) | undefined;
}

/**
 * What leaving a lishnet does to ONE download — see the observer in
 * {@link initTransferHandlers} for why each is handled on its own.
 *
 * Lifted out of that closure so the isolation it exists for can be exercised directly:
 * the observer's whole point is that one download blowing up must not cost the ones
 * behind it their cleanup, and that is not something the surrounding handlers can be
 * asked to demonstrate.
 */
export function handleLeftDownloader(deps: LeftDownloaderDeps, networkID: string, lishID: string, dl: Downloader): void {
	const ids = dl.getNetworkIDs?.() ?? [];
	if (!ids.includes(networkID)) return;
	if (ids.some(id => deps.networks.isJoined(id))) {
		// Another joined lishnet can still source this download — keep it
		// running but stop using the network we just left, otherwise the
		// downloader keeps broadcasting WANTs and probing peers on a topic
		// we are no longer part of.
		dl.removeNetwork?.(networkID);
		return;
	}
	// Drop the left lishnet here too. The download is about to be disabled, but
	// disabled is not discarded: rejoining a DIFFERENT lishnet of this download
	// resumes it, and anything left in the set would then be broadcast on
	// again — a topic we are no longer part of.
	dl.removeNetwork?.(networkID);
	// Drop the runtime enabled flag (no DB persist) so `lishs.list` reports the
	// download as stopped and restartDownloadIfEnabled cannot silently revive it
	// while no usable lishnet is joined. The DB flag stays untouched, so an app
	// restart with the lishnet re-joined resumes the download.
	const wasEnabled = deps.downloadEnabledLishs.has(lishID);
	deps.downloadEnabledLishs.delete(lishID);
	// Cancel any pending error-recovery timer for this LISH — otherwise
	// ErrorRecovery, holding the captured downloadWasEnabled=true, could
	// re-enable the download once the IO condition clears even though the
	// user just stopped it by leaving the network.
	deps.recovery.stop(lishID);
	if (wasEnabled) {
		// Persisted download — retain the disabled downloader and remember it as
		// suspended-by-leave so onNetworkJoined can resume it after rejoin.
		console.log(`[Transfer] ${lishID.slice(0, 8)}: last joined lishnet left, disabling download`);
		dl.disable();
		// Bind resume to the download's ORIGINAL lishnets (not the current set,
		// which removeNetwork may have shrunk) so only a re-join of a lishnet this
		// download actually belongs to resumes it.
		deps.networkSuspended.set(lishID, new Set(dl.getOriginalNetworkIDs?.() ?? dl.getNetworkIDs?.() ?? []));
	} else {
		// Transient download (from the `download` handler, never enabled/persisted)
		// has no resume claim — destroy it and drop it from the map instead of
		// leaking a disabled downloader with a dangling download() promise and
		// registered network handlers (a fresh start of the same LISH would
		// otherwise overwrite the map entry without disposing this one).
		console.log(`[Transfer] ${lishID.slice(0, 8)}: last joined lishnet left, dropping transient download`);
		dl.destroy().catch(err => console.error(`[Transfer] ${lishID.slice(0, 8)}: destroy on leave failed:`, err?.message ?? err));
		deps.activeDownloaders.delete(lishID);
	}
	// dl.disable() alone emits nothing over WS — tell the FE the download
	// stopped.
	deps.broadcast?.('transfer.download:disabled', { lishID });
}

export function initTransferHandlers(networks: Networks, dataServer: DataServer, dataDir: string, emit: EmitFn, broadcast?: BroadcastFn, settings?: Settings, triggerVerification?: (lishID: string) => void, finalizeDownload?: (lishID: string) => Promise<{ success: boolean }>): TransferHandlers {
	const activeDownloaders = new Map<string, Downloader>();
	let transfersPaused = false;
	setActiveDownloadersRef(activeDownloaders);

	// LISHs whose download was suspended because their last joined lishnet was left,
	// mapped to the lishnets they were bound to. Their DB enabled flag stays on (see
	// onNetworkLeft), so onNetworkJoined resumes them — but only when a BOUND lishnet
	// re-joins, never rebinding to an unrelated one. An empty bound set means "no known
	// binding" (startup with no joined lishnet, where the fresh downloader would bind
	// to whatever is enabled at resume time) → resume on any join. Cleared when the
	// user explicitly enables/disables the download so a rejoin never overrides a
	// deliberate user action.
	const networkSuspended = new Map<string, Set<string>>();
	setNetworkSuspendedRef(networkSuspended);

	// When a lishnet is left, stop any download bound EXCLUSIVELY to it: a
	// downloader keeps running as long as at least one of its networks is still
	// joined (multi-network downloads can still source chunks elsewhere). Only
	// when none of its networks remain joined is there no peer source left, so we
	// disable it (leaving DB/enabled flags untouched — a re-join can resume it).
	// Each downloader is handled in its own try/catch. This runs as a lishnet observer, and
	// the transition it is told about has ALREADY happened — the topic is unsubscribed and
	// the membership dropped — so a throw here cannot undo anything, and the observer is not
	// run a second time. One downloader that blew up used to take every downloader after it
	// with it: they kept broadcasting WANTs on a topic this node had left, with nothing left
	// to come back and stop them.
	networks.onNetworkLeft = (networkID: string) => {
		for (const [lishID, dl] of activeDownloaders) {
			try {
				handleLeftFor(networkID, lishID, dl);
			} catch (err: any) {
				console.error(`[Transfer] ${lishID.slice(0, 8)}: handling the leave of ${networkID.slice(0, 8)} failed:`, err?.message ?? err);
			}
		}
	};

	/** See {@link handleLeftDownloader}; this only supplies what that needs. */
	function handleLeftFor(networkID: string, lishID: string, dl: Downloader): void {
		handleLeftDownloader({ networks, downloadEnabledLishs, networkSuspended, activeDownloaders, recovery, broadcast }, networkID, lishID, dl);
	}

	// When a previously-left lishnet is re-joined in-process, resume downloads that
	// were suspended because it was their last joined network. Their DB enabled flag
	// was intentionally left on (see onNetworkLeft), so re-enabling here restores the
	// pre-leave state without waiting for an app restart. Only downloads still bound
	// to the re-joined network and still suspended are resumed.
	// Per download, in its own try/catch, for the same reason as the leave observer above:
	// the join has already happened and nothing re-runs this, so one downloader that throws
	// must not cost every download behind it its resume.
	networks.onNetworkJoined = (networkID: string) => {
		// Re-attach the rejoined network to still-running multi-network downloaders
		// that dropped it when it was left (no-op if never bound to it or already active).
		for (const [lishID, dl] of activeDownloaders) {
			try {
				dl.addNetwork?.(networkID);
			} catch (err: any) {
				console.error(`[Transfer] ${lishID.slice(0, 8)}: re-attaching ${networkID.slice(0, 8)} failed:`, err?.message ?? err);
			}
		}
		// Resume a suspended download only when a lishnet it is BOUND to re-joins (an
		// empty bound set = no known binding → resume on any join). Drop the suspension
		// ONLY once the resume actually succeeds — a transient failure (busy verifying,
		// still no joined lishnet) must be retried on the next join.
		for (const [lishID, bound] of [...networkSuspended]) {
			if (bound.size > 0 && !bound.has(networkID)) continue;
			try {
				enableDownload({ lishID })
					.then(r => {
						if (r.success) {
							networkSuspended.delete(lishID);
							console.log(`[Transfer] ${lishID.slice(0, 8)}: lishnet re-joined, download resumed`);
						}
					})
					.catch(err => console.error(`[Transfer] resume-on-rejoin ${lishID.slice(0, 8)} failed:`, err?.message ?? err));
			} catch (err: any) {
				console.error(`[Transfer] resume-on-rejoin ${lishID.slice(0, 8)} failed:`, err?.message ?? err);
			}
		}
	};

	// Error recovery: auto-retry when IO conditions clear
	const recovery = new ErrorRecovery({
		attemptRecover: async (lishID, downloadWasEnabled, uploadWasEnabled): Promise<boolean> => {
			let ok = true;
			if (downloadWasEnabled) {
				const result = await enableDownload({ lishID });
				if (!result.success) ok = false;
			}
			if (uploadWasEnabled && ok) enableUploadHandler({ lishID });
			return ok;
		},
		broadcast: (event, data): void => {
			broadcast?.(event, data);
		},
		getLISH: (lishID): any => dataServer.get(lishID) ?? (undefined as any),
		checkAccess: async (path): Promise<void> => {
			await access(path, constants.R_OK | constants.W_OK);
		},
	});

	function startRecoveryIfEnabled(lishID: string, errorCode: string, prev: { downloadEnabled: boolean; uploadEnabled: boolean }): void {
		if (settings?.get('network.autoErrorRecovery') === false) return;
		recovery.start(lishID, errorCode, prev);
	}

	async function download(p: { networkID: string; lishPath: string }, client: any): Promise<DownloadResponse> {
		assert(p, ['networkID', 'lishPath']);
		if (transfersPaused) throw new CodedError(ErrorCodes.DOWNLOAD_ERROR, 'Transfers are paused during factory reset');
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
		downloader.setRetryCallback?.(info => {
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
		networkSuspended.delete(p.lishID);
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

	async function startStoredDownloader(lishID: string, networkIDs: string[], originalNetworkIDs: string[], disabled: boolean, client?: any): Promise<Downloader> {
		const lish = dataServer.get(lishID);
		if (!lish) throw new Error(`Cannot restore download ${lishID}: LISH is missing`);
		const downloadDir = lish.directory ?? join(dataDir, 'downloads', Date.now().toString());
		if (lish.directory) {
			const hasChunks = dataServer.getAllChunkCount(lishID) > dataServer.getMissingChunks(lishID).length;
			await access(hasChunks ? downloadDir : dirname(downloadDir), constants.R_OK | constants.W_OK);
		}

		const downloader = new Downloader(downloadDir, networks.getRunningNetwork(), dataServer, networkIDs, originalNetworkIDs);
		await downloader.initFromManifest(lish);
		activeDownloaders.set(lishID, downloader);
		const send = broadcast ?? ((event: string, data: any) => emit(client, event, data));
		downloader.setProgressCallback?.((info: { downloadedChunks: number; totalChunks: number; peers: number; bytesPerSecond: number }) => {
			send('transfer.download:progress', { lishID, ...info });
		});
		downloader.setRetryCallback?.(info => {
			if (info.resolved) send('transfer.download:resumed', { lishID });
			else send('transfer.download:retrying', { lishID, ...info });
		});
		if (disabled) downloader.disable();
		const running = downloader.download();
		running
			.then(async () => {
				if (activeDownloaders.get(lishID) === downloader) activeDownloaders.delete(lishID);
				send('transfer.download:complete', { downloadDir, lishID });
				if (finalizeDownload) {
					try {
						await finalizeDownload(lishID);
					} catch (err) {
						console.error(`[Transfer] ${lishID.slice(0, 8)}: finalizeDownload failed`, err);
					}
				}
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
		return downloader;
	}

	async function enableDownload(p: { lishID: string }, client?: any): Promise<{ success: boolean }> {
		assert(p, ['lishID']);
		if (transfersPaused) return { success: false };
		if (isBusy(p.lishID)) return { success: false };
		if (pendingDownloads.has(p.lishID)) return { success: true };
		dataServer.clearError(p.lishID);
		downloadEnabledLishs.add(p.lishID);
		persistDownloadEnabled?.(p.lishID, true);
		const dl = activeDownloaders.get(p.lishID);
		if (dl) {
			// A download suspended by leaving its last lishnet is retained (disabled) for
			// resume on rejoin. Enabling it before a bound lishnet is re-joined would make
			// it broadcast WANTs / probe on a topic we already left — keep it suspended.
			const boundIDs = dl.getOriginalNetworkIDs?.() ?? dl.getNetworkIDs?.() ?? [];
			if (networkSuspended.has(p.lishID) && boundIDs.length > 0 && !boundIDs.some((id: string) => networks.isJoined(id))) {
				// Drop the runtime enabled flag we just set; the DB flag (persisted above)
				// stays true so a later rejoin of a bound lishnet resumes the download.
				downloadEnabledLishs.delete(p.lishID);
				return { success: false };
			}
			// If downloader is in error state, destroy it and create a fresh one
			if (dl.getError()) {
				console.debug(`[Transfer] ${p.lishID.slice(0, 8)}: destroying error-state downloader, will create fresh`);
				dl.destroy();
				activeDownloaders.delete(p.lishID);
				// Fall through to create new downloader below
			} else {
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
		}
		// No active downloader — start a new download if LISH exists in dataServer
		const lish = dataServer.get(p.lishID);
		if (!lish) {
			downloadEnabledLishs.delete(p.lishID);
			persistDownloadEnabled?.(p.lishID, false);
			return { success: false };
		}
		const missing = dataServer.getMissingChunks(p.lishID);
		if (missing.length === 0 && dataServer.getAllChunkCount(p.lishID) > 0) {
			// DB says complete — but verify files actually exist on disk
			if (lish.files && lish.directory) {
				let diskOk = true;
				for (const file of lish.files) {
					const filePath = join(lish.directory, file.path);
					const f = Bun.file(filePath);
					if (!(await f.exists()) || f.size !== file.size) {
						diskOk = false;
						break;
					}
				}
				if (!diskOk) {
					// Files missing on disk — reset ALL chunks and start fresh download
					console.warn(`[Transfer] ${p.lishID.slice(0, 8)}: DB says complete but files missing on disk, resetting for re-download`);
					dataServer.resetVerification(p.lishID);
					// Fall through to start download — verify in ENOENT recovery will set accurate per-file state
				} else {
					const send = broadcast ?? (() => {});
					send('transfer.download:enabled', { lishID: p.lishID });
					return { success: true };
				}
			} else {
				const send = broadcast ?? (() => {});
				send('transfer.download:enabled', { lishID: p.lishID });
				return { success: true };
			}
		}
		pendingDownloads.add(p.lishID);
		try {
			const joinedNetworks = getJoinedEnabledNetworkIDs(networks);
			if (joinedNetworks.length === 0) {
				// No lishnet is joined to source this download. Keep the DB enabled flag
				// ON — clearing it would permanently forget the user's intent so a later
				// rejoin could never resume. Drop only the in-memory active flag and mark
				// it suspended so onNetworkJoined resumes it once a lishnet is (re-)joined.
				downloadEnabledLishs.delete(p.lishID);
				// No active downloader and no joined lishnet → no known network binding
				// (the fresh downloader would bind to getEnabled(), empty here). Store the
				// empty bound set so onNetworkJoined resumes on any join, since the DB has
				// no per-download network to restrict to.
				networkSuspended.set(p.lishID, new Set(joinedNetworks));
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
			await startStoredDownloader(p.lishID, joinedNetworks, joinedNetworks, false, client);
			recovery.stop(p.lishID);
			const send = broadcast ?? (() => {});
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
	setStopRecoveryFn(lishID => recovery.stop(lishID));
	// Hook upload I/O errors into download recovery
	setUploadRecoveryHooks(
		(lishID, errorCode, prev) => startRecoveryIfEnabled(lishID, errorCode, prev),
		lishID => downloadEnabledLishs.has(lishID),
		triggerVerification
	);

	function getActiveTransfers(): ActiveTransfer[] {
		const transfers: ActiveTransfer[] = [];
		const enabled = getEnabledUploads();
		// Active downloads — report the allocation phase distinctly so the UI can show
		// "allocating" after a reconnect instead of falling back to idle (no peers yet).
		// A downloader disabled by leaving its last lishnet stays in the map (retained
		// for resume on rejoin) but is stopped — skip it so the LISH is not reported as
		// still downloading after transfer.download:disabled.
		for (const [lishID, dl] of activeDownloaders) {
			if (dl.isDisabled?.()) continue;
			const type = dl.isAllocating?.() ? 'allocating' : 'downloading';
			transfers.push({ lishID, type, peers: dl.getPeerCount?.() ?? 0, bytesPerSecond: 0 });
		}
		// Active uploads
		for (const [lishID, info] of getActiveUploads()) {
			if (!enabled.has(lishID)) {
				transfers.push({ lishID, type: 'upload-disabled', peers: 0, bytesPerSecond: 0 });
			} else {
				const now = Date.now();
				const cutoff = now - 10000;
				let pruneIdx = 0;
				while (pruneIdx < info.speedSamples.length && info.speedSamples[pruneIdx]!.time <= cutoff) pruneIdx++;
				if (pruneIdx > 0) info.speedSamples.splice(0, pruneIdx);
				const windowBytes = info.speedSamples.reduce((sum: number, s: any) => sum + s.bytes, 0);
				const oldestTime = info.speedSamples.length > 1 ? info.speedSamples[0]!.time : now;
				const elapsed = (now - oldestTime) / 1000;
				const bytesPerSecond = elapsed >= 0.5 ? Math.round(windowBytes / elapsed) : 0;
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
		if (transfersPaused) return { success: false };
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
		assert(p, ['lishID']);
		subscribePeers(client, p.lishID);
		return true;
	}

	function unsubscribePeersHandler(p: { lishID: string }, client: any): boolean {
		assert(p, ['lishID']);
		unsubscribePeers(client, p.lishID);
		return true;
	}

	function debugPeersHandler(p: { lishID?: string }): ReturnType<typeof getDebugSnapshot> {
		return getDebugSnapshot(p?.lishID);
	}

	/**
	 * Manually trigger an immediate peer-discovery cycle for the given LISH ("Find peers" UI button).
	 * Returns success=false when no active downloader exists for the LISH (e.g. download already finished
	 * or never started). Repeated clicks are intentionally cheap; remote peers rate-limit their HAVE
	 * responses so manual spam is harmless.
	 */
	function findPeersHandler(p: { lishID: string }): { success: boolean } {
		assert(p, ['lishID']);
		const dl = activeDownloaders.get(p.lishID);
		if (!dl) return { success: false };
		dl.triggerPeerDiscovery();
		return { success: true };
	}

	/**
	 * Tear down all in-memory transfer state (factory reset): destroy every active
	 * downloader, clear the enabled-download set, wipe upload state, and stop all
	 * pending error recovery. Does not touch the DB or on-disk files.
	 */
	async function clearAllTransfers(): Promise<void> {
		// Close admission before the first await so another WebSocket request cannot
		// start a transfer between teardown and the destructive database wipe.
		transfersPaused = true;
		const downloaderState = new Map(
			[...activeDownloaders].map(([lishID, downloader]) => [
				lishID,
				{
					networkIDs: downloader.getNetworkIDs?.() ?? [],
					originalNetworkIDs: downloader.getOriginalNetworkIDs?.() ?? downloader.getNetworkIDs?.() ?? [],
					disabled: downloader.isDisabled?.() ?? false,
				},
			])
		);
		await destroyAllDownloaders(activeDownloaders, async lishID => {
			const state = downloaderState.get(lishID);
			if (!state) throw new Error(`Cannot restore download ${lishID}: reset snapshot is missing`);
			return startStoredDownloader(lishID, state.networkIDs, state.originalNetworkIDs, state.disabled);
		});
		downloadEnabledLishs.clear();
		networkSuspended.clear();
		clearAllUploads();
		recovery.stopAll();
	}

	function resumeAllTransfers(): void {
		transfersPaused = false;
	}

	return { download, disableDownload, enableDownload, disableUpload: disableUploadHandler, enableUpload: enableUploadHandler, getActiveTransfers, subscribePeers: subscribePeersHandler, unsubscribePeers: unsubscribePeersHandler, debugPeers: debugPeersHandler, findPeers: findPeersHandler, clearAll: clearAllTransfers, resumeAll: resumeAllTransfers };
}
