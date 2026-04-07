import { writable, derived, get } from 'svelte/store';
import { type ILISHDetail } from '@shared';
import { api } from './api.ts';
import { formatSize } from './utils.ts';
import { navigateBack } from './navigation.ts';
import { addNotification } from './notifications.ts';
import { tt } from './language.ts';

export type DownloadStatus = 'downloading' | 'uploading' | 'downloading-uploading' | 'idling' | 'verifying' | 'pending-verification' | 'moving' | 'allocating' | 'error' | 'retrying';
export type EnabledMode = 'disabled' | 'download' | 'upload' | 'both';

export function computeEnabledMode(downloadEnabled: boolean, uploadEnabled: boolean): EnabledMode {
	if (downloadEnabled && uploadEnabled) return 'both';
	if (downloadEnabled) return 'download';
	if (uploadEnabled) return 'upload';
	return 'disabled';
}

// ============================================================================
// Download Data Types
// ============================================================================

export type DownloadFileType = 'file' | 'directory' | 'link';

export interface DownloadFileData {
	id: number;
	name: string;
	type: DownloadFileType;
	progress: number;
	size: string;
	rawSize: number;
	totalChunks: number;
	verifiedChunks: number;
	downloadedSize?: string;
	linkTarget?: string;
}

export interface DownloadData {
	id: string;
	name: string;
	description?: string | undefined;
	directory?: string | undefined;
	progress: number;
	size: string;
	rawTotalSize: number;
	downloadedSize?: string;
	status: DownloadStatus;
	downloadEnabled: boolean;
	uploadEnabled: boolean;
	downloadPeers: number;
	uploadPeers: number;
	downloadSpeed: string;
	rawDownloadSpeed: number;
	uploadSpeed: string;
	rawUploadSpeed: number;
	files: DownloadFileData[];
	verifiedChunks: number;
	totalChunks: number;
	chunkSize: number;
	totalUploadedBytes: number;
	totalDownloadedBytes: number;
	errorCode?: string | undefined;
	errorMessage?: string | undefined;
	recoveryRetryCount?: number | undefined;
	recoveryNextAt?: number | undefined;
	retryErrorCode?: string | undefined;
	retryCount?: number | undefined;
	retryMaxRetries?: number | undefined;
}

/**
 * Convert a backend ILISHDetail to frontend DownloadData.
 */
function detailToDownload(detail: ILISHDetail): DownloadData {
	let nextID = 0;
	const files: DownloadFileData[] = detail.files.map(f => {
		const totalChunks = f.totalChunks > 0 ? f.totalChunks : Math.ceil(f.size / detail.chunkSize);
		const verifiedChunks = f.verifiedChunks ?? 0;
		const progress = totalChunks > 0 ? Math.round((verifiedChunks / totalChunks) * 10000) / 100 : 0;
		const downloadedSize = totalChunks > 0 && verifiedChunks > 0 ? formatSize(Math.round((f.size * verifiedChunks) / totalChunks)) : '0 B';
		return {
			id: nextID++,
			name: f.path,
			type: 'file' as DownloadFileType,
			progress,
			size: formatSize(f.size),
			rawSize: f.size,
			totalChunks,
			verifiedChunks,
			downloadedSize,
		};
	});
	for (const d of detail.directories) {
		files.push({ id: nextID++, name: d.path, type: 'directory', progress: 100, size: '-', rawSize: 0, totalChunks: 0, verifiedChunks: 0 });
	}
	for (const l of detail.links) {
		files.push({ id: nextID++, name: l.path, type: 'link', progress: 100, size: '-', rawSize: 0, totalChunks: 0, verifiedChunks: 0, linkTarget: l.target });
	}
	files.sort((a, b) => a.name.localeCompare(b.name));
	const progress = detail.totalChunks > 0 ? Math.round((detail.verifiedChunks / detail.totalChunks) * 10000) / 100 : 0;
	const downloadedSize = detail.totalSize > 0 && detail.verifiedChunks > 0 ? formatSize(Math.round((detail.totalSize * detail.verifiedChunks) / detail.totalChunks)) : '0 B';
	return {
		id: detail.id,
		name: detail.name ?? '-',
		description: detail.description,
		directory: detail.directory,
		progress,
		size: formatSize(detail.totalSize),
		rawTotalSize: detail.totalSize,
		downloadedSize,
		status: 'idling',
		downloadEnabled: false,
		uploadEnabled: false,
		downloadPeers: 0,
		uploadPeers: 0,
		downloadSpeed: '0 B/s',
		rawDownloadSpeed: 0,
		uploadSpeed: '0 B/s',
		rawUploadSpeed: 0,
		files,
		verifiedChunks: detail.verifiedChunks,
		totalChunks: detail.totalChunks,
		chunkSize: detail.chunkSize,
		totalUploadedBytes: detail.totalUploadedBytes ?? 0,
		totalDownloadedBytes: detail.totalDownloadedBytes ?? 0,
	};
}

// ============================================================================
// Stores
// ============================================================================

// Statuses that should not be overridden by transfer events
function isStatusLocked(status: DownloadStatus): boolean {
	return status === 'verifying' || status === 'pending-verification' || status === 'moving' || status === 'error' || status === 'retrying';
}

// Helper: compute combined status from download/upload activity flags
function computeStatus(isDown: boolean, isUp: boolean): DownloadStatus {
	if (isDown && isUp) return 'downloading-uploading';
	if (isDown) return 'downloading';
	if (isUp) return 'uploading';
	return 'idling';
}

let handlersRegistered = false;
let currentDetailLISHID: string | null = null;

export const downloads = writable<DownloadData[]>([]);
export const downloadsLoading = writable<boolean>(true);
export const transferStats = derived(downloads, $dl => {
	let dlPeers = 0, ulPeers = 0, dlSpeed = 0, ulSpeed = 0;
	for (const d of $dl) {
		dlPeers += d.downloadPeers;
		ulPeers += d.uploadPeers;
		dlSpeed += d.rawDownloadSpeed;
		ulSpeed += d.rawUploadSpeed;
	}
	return { downloadPeers: dlPeers, uploadPeers: ulPeers, downloadSpeed: dlSpeed, uploadSpeed: ulSpeed };
});
// Track which LISHs are actively downloading (by lishID → last progress timestamp)
const activeDownloads = new Map<string, number>();
// Track explicitly disabled downloads (prevents progress events from overriding disabled state)
const disabledDownloads = new Set<string>();
// Last known chunk counts for session delta calculation
const lastDownloadedChunks = new Map<string, number>();
const lastUploadedChunks = new Map<string, number>();

export function setCurrentDetailLISHID(lishID: string | null): void {
	currentDetailLISHID = lishID;
}

/**
 * Initialize download state: load all details from backend, subscribe to events.
 * Called from onConnected — may be called multiple times on reconnect.
 * Event handlers are registered once, subscriptions are sent on every connect.
 */
export async function initDownloads(): Promise<void> {
	// Reload data on every connect
	downloadsLoading.set(true);
	let verifying: string | null = null;
	let pendingVerification: string[] = [];
	let moving: string[] = [];
	let ulEnabled: string[] = [];
	let dlEnabled: string[] = [];
	try {
		const { items: summaries, verifying: v, pendingVerification: pv, moving: mv, uploadEnabled: ue, downloadEnabled: de } = await api.lishs.list(undefined, 'desc');
		verifying = v;
		pendingVerification = pv;
		moving = mv;
		ulEnabled = ue ?? [];
		dlEnabled = de ?? [];
		const ulSet = new Set(ulEnabled);
		const dlSet = new Set(dlEnabled);
		const summaryMap = new Map(summaries.map(s => [s.id, s]));
		const details = await Promise.all(summaries.map(s => api.lishs.get(s.id)));
		downloads.set(
			details
				.filter((d): d is ILISHDetail => d !== null)
				.map(d => {
					const entry = detailToDownload(d);
					entry.uploadEnabled = ulSet.has(d.id);
					entry.downloadEnabled = dlSet.has(d.id);
					if (moving.includes(d.id)) entry.status = 'moving';
					else if (d.id === verifying) entry.status = 'verifying';
					else if (pendingVerification.includes(d.id)) entry.status = 'pending-verification';
					const summary = summaryMap.get(d.id);
					if (summary?.errorCode) {
						entry.status = 'error';
						entry.errorCode = summary.errorCode;
						entry.errorMessage = summary.errorDetail;
					}
				return entry;
				})
		);
	} catch (err) {
		console.error('Failed to load LISH list:', err);
		downloads.set([]);
	} finally {
		downloadsLoading.set(false);
	}

	// Restore transfer states after F5/reconnect
	// Status = actual activity (peers > 0 only), enabled flags already set from lishs.list()
	try {
		const transfers = await api.call('transfer.getActiveTransfers', {}) as { lishID: string; type: string; peers: number; bytesPerSecond: number }[];
		if (transfers?.length) {
			downloads.update(list => list.map(d => {
				const mine = transfers.filter(t => t.lishID === d.id);
				const ul = mine.find(t => t.type === 'uploading');
				const dl = mine.find(t => t.type === 'downloading');
				// Only show as active when peers are actually connected
				const isActiveDown = !!dl && dl.peers > 0;
				const isActiveUp = !!ul && ul.peers > 0;
				const status: DownloadStatus = computeStatus(isActiveDown, isActiveUp);
				return {
					...d,
					...(status !== 'idling' && !isStatusLocked(d.status) ? { status } : {}),
					...(dl ? { downloadPeers: dl.peers, downloadSpeed: dl.bytesPerSecond ? formatSize(dl.bytesPerSecond) + '/s' : d.downloadSpeed, rawDownloadSpeed: dl.bytesPerSecond ?? 0 } : {}),
					...(ul ? { uploadPeers: ul.peers, uploadSpeed: formatSize(ul.bytesPerSecond) + '/s', rawUploadSpeed: ul.bytesPerSecond ?? 0 } : {}),
				};
			}));
		}
	} catch { /* transfer API may not exist on older backends */ }

	// Register event handlers only once (they persist across reconnects)
	if (!handlersRegistered) {
		handlersRegistered = true;

		// lishs:add — new LISH created or imported (broadcast from backend)
		api.on('lishs:add', (detail: ILISHDetail) => {
			downloads.update(list => {
				const idx = list.findIndex(d => d.id === detail.id);
				const entry = detailToDownload(detail);
				// If actively downloading (progress event within last 30s), preserve download state
				const lastProgress = activeDownloads.get(detail.id);
				const isActive = lastProgress && (Date.now() - lastProgress) < 30_000;
				if (idx >= 0) {
					const existing = list[idx]!;
					if (isActive || existing.status === 'downloading') {
						entry.status = 'downloading';
						entry.downloadPeers = existing.downloadPeers;
						entry.downloadSpeed = existing.downloadSpeed;
						entry.progress = existing.progress > entry.progress ? existing.progress : entry.progress;
						if (existing.downloadedSize !== undefined) entry.downloadedSize = existing.downloadedSize;
					}
					const updated = [...list];
					updated[idx] = entry;
					return updated;
				}
				// New entry — if active download, set status
				if (isActive) entry.status = 'downloading';
				addNotification(tt('downloads.lishAdded', { name: detail.name ?? detail.id }), 'info');
				return [entry, ...list];
			});
		});

		// lishs:remove — LISH deleted (broadcast from backend)
		api.on('lishs:remove', (data: { lishID: string }) => {
			if (currentDetailLISHID === data.lishID) navigateBack();
			downloads.update(list => list.filter(d => d.id !== data.lishID));
			activeDownloads.delete(data.lishID);
			disabledDownloads.delete(data.lishID);
			lastDownloadedChunks.delete(data.lishID);
			lastUploadedChunks.delete(data.lishID);
		});

		// lishs:verify — verification progress (broadcast from backend)
		api.on('lishs:verify', (data: { lishID: string; filePath: string; verifiedChunks: number; done?: boolean; reset?: boolean; queued?: boolean; started?: boolean }) => {
			// console.log('[downloads] lishs:verify received:', data.filePath, 'verified:', data.verifiedChunks, 'done:', data.done);
			if (data.reset) {
				return;
			}
			if (data.queued) {
				downloads.update(list =>
					list.map(d => {
						if (d.id !== data.lishID || d.status === 'moving' || d.status === 'downloading' || d.status === 'downloading-uploading' || d.status === 'allocating') return d;
						return { ...d, status: 'pending-verification' as DownloadStatus };
					})
				);
				return;
			}
			if (data.started) {
				downloads.update(list =>
					list.map(d => {
						if (d.id !== data.lishID || d.status === 'moving' || d.status === 'downloading' || d.status === 'downloading-uploading' || d.status === 'allocating') return d;
						return { ...d, status: 'verifying' as DownloadStatus };
					})
				);
				return;
			}
			if (data.done) {
				const lish = get(downloads).find(d => d.id === data.lishID);
				if (lish && lish.status !== 'moving' && lish.status !== 'downloading' && lish.status !== 'downloading-uploading' && lish.status !== 'allocating') {
					addNotification(tt('downloads.verifyDone', { name: lish.name }), 'success');
				}
				// Refresh from backend to restore correct download progress (verification overwrites progress values)
				api.lishs.get(data.lishID).then(detail => {
					if (!detail) return;
					const fresh = detailToDownload(detail);
					downloads.update(list => list.map(d => {
						if (d.id !== data.lishID) return d;
						if (d.status === 'moving' || d.status === 'downloading' || d.status === 'downloading-uploading' || d.status === 'allocating') return d;
						return { ...d, ...fresh, status: 'idling' as DownloadStatus, downloadEnabled: d.downloadEnabled, uploadEnabled: d.uploadEnabled };
					}));
				});
				return;
			}
			downloads.update(list =>
				list.map(d => {
					if (d.id !== data.lishID || d.status === 'moving' || d.status === 'downloading' || d.status === 'downloading-uploading' || d.status === 'allocating') return d;
					let overallVerified = 0;
					const files = d.files.map(f => {
						const fVerified = f.name === data.filePath ? data.verifiedChunks : f.verifiedChunks;
						overallVerified += fVerified;
						if (f.name !== data.filePath) return f;
						const fileProgress = f.totalChunks > 0 ? Math.round((fVerified / f.totalChunks) * 10000) / 100 : 0;
						const downloadedSize = f.totalChunks > 0 ? formatSize(Math.round((f.rawSize * fVerified) / f.totalChunks)) : '0 B';
						return { ...f, verifiedChunks: fVerified, progress: fileProgress, downloadedSize };
					});
					const status: DownloadStatus = overallVerified === d.totalChunks ? 'idling' : 'verifying';
					const progress = d.totalChunks > 0 ? Math.round((overallVerified / d.totalChunks) * 10000) / 100 : 0;
					const downloadedSize = d.totalChunks > 0 ? formatSize(Math.round((d.rawTotalSize * overallVerified) / d.totalChunks)) : '0 B';
					return { ...d, verifiedChunks: overallVerified, status, progress, files, downloadedSize };
				})
			);
		});

		// lishs:move — LISH data moved (broadcast from backend)
		api.on('lishs:move', (data: { lishID: string; directory: string }) => {
			const lish = get(downloads).find(d => d.id === data.lishID);
			if (lish) addNotification(tt('downloads.moveSuccess', { name: lish.name }), 'success');
			downloads.update(list =>
				list.map(d => {
					if (d.id !== data.lishID) return d;
					return { ...d, directory: data.directory };
				})
			);
		});

		// lishs:move:status — moving status change (broadcast from backend to all clients)
		api.on('lishs:move:status', (data: { lishID: string; moving: boolean }) => {
			downloads.update(list =>
				list.map(d => {
					if (d.id !== data.lishID) return d;
					return { ...d, status: data.moving ? ('moving' as DownloadStatus) : ('idling' as DownloadStatus) };
				})
			);
		});

		// lishs:move:progress — update move progress percentage (byte-weighted) + per-file progress
		api.on('lishs:move:progress', (data: { lishID: string; type: string; totalBytes: number; completedBytes: number; path?: string; fileBytes?: number; fileSize?: number }) => {
			if (data.type !== 'file-list' && data.type !== 'file' && data.type !== 'chunk') return;
			const progress = data.totalBytes > 0 ? Math.round((data.completedBytes / data.totalBytes) * 10000) / 100 : 0;
			downloads.update(list =>
				list.map(d => {
					if (d.id !== data.lishID) return d;
					let files = d.files;
					if (data.type === 'file-list') files = d.files.map(f => ({ ...f, progress: 0 }));
					else if (data.type === 'chunk' && data.path) {
						const fp = data.fileSize && data.fileSize > 0 ? Math.round(((data.fileBytes ?? 0) / data.fileSize) * 10000) / 100 : 0;
						files = d.files.map(f => (f.name === data.path ? { ...f, progress: fp } : f));
					} else if (data.type === 'file' && data.path) files = d.files.map(f => (f.name === data.path ? { ...f, progress: 100 } : f));
					return { ...d, progress, files };
				})
			);
		});

		// Track which LISHs are uploading (set by upload:progress, cleared by timeout)
		const activeUploadLishs = new Set<string>();

		// transfer.download:progress — with stale timeout to reset peers/speed
		const downloadStaleTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
		api.on('transfer.download:progress', (data: { lishID: string; downloadedChunks: number; totalChunks: number; peers: number; bytesPerSecond?: number; filePath?: string; fileDownloadedChunks?: number; allocatingFile?: string; allocatingFileProgress?: number }) => {
			// Allocating signal — always process (even if disabled — clears stale disabled state)
			if (data.filePath === '__allocating__') {
				disabledDownloads.delete(data.lishID);
				// Clear stale timeout — allocation can take minutes on Docker overlay2
				const prevTimer = downloadStaleTimeouts.get(data.lishID);
				if (prevTimer) { clearTimeout(prevTimer); downloadStaleTimeouts.delete(data.lishID); }
				downloads.update(list => list.map(d => {
					if (d.id !== data.lishID) return d;
					if (d.status !== 'allocating' && isStatusLocked(d.status)) return d;
					const allocProgress = data.fileDownloadedChunks ?? 0;
					// Update per-file allocation progress
					let files = d.files;
					if (data.allocatingFile) {
						let pastCurrent = false;
						files = d.files.map(f => {
							if (f.type !== 'file') return f;
							if (f.name === data.allocatingFile) {
								pastCurrent = true;
								return { ...f, progress: data.allocatingFileProgress ?? 0 };
							}
							if (!pastCurrent) return { ...f, progress: 100 }; // already allocated
							return { ...f, progress: 0 }; // not yet allocated
						});
					}
					return { ...d, status: 'allocating' as DownloadStatus, progress: allocProgress, files };
				}));
				return;
			}
			if (data.peers > 0) activeDownloads.set(data.lishID, Date.now());
			else activeDownloads.delete(data.lishID);
			const hasPeers = data.peers > 0;
			// Calculate delta chunks since last event for cumulative byte tracking
			const prevChunks = lastDownloadedChunks.get(data.lishID) ?? data.downloadedChunks;
			const deltaChunks = Math.max(0, data.downloadedChunks - prevChunks);
			lastDownloadedChunks.set(data.lishID, data.downloadedChunks);
			downloads.update(list =>
				list.map(d => {
					if (d.id !== data.lishID) return d;
					const progress = data.totalChunks > 0 ? Math.round((data.downloadedChunks / data.totalChunks) * 10000) / 100 : 0;
					const downloadedSize = d.rawTotalSize > 0 && data.totalChunks > 0 ? formatSize(Math.round((d.rawTotalSize * data.downloadedChunks) / data.totalChunks)) : '?';
					const downloadSpeed = data.bytesPerSecond ? formatSize(data.bytesPerSecond) + '/s' : (data.peers === 0 ? '0 B/s' : d.downloadSpeed);
					const status = isStatusLocked(d.status) ? d.status : computeStatus(hasPeers, activeUploadLishs.has(data.lishID));
					const totalDownloadedBytes = d.totalDownloadedBytes + (deltaChunks > 0 && d.chunkSize > 0 ? deltaChunks * d.chunkSize : 0);
					// Fix stale allocation progress: any file with progress>0 but verifiedChunks=0 was from allocation display
					let files = d.files.map(f => (f.type === 'file' && f.progress > 0 && f.verifiedChunks === 0) ? { ...f, progress: 0, downloadedSize: '0 B' } : f);
					if (data.filePath && data.fileDownloadedChunks != null) {
						files = files.map(f => {
							if (f.name !== data.filePath) return f;
							const fVerified = data.fileDownloadedChunks!;
							const fileProgress = f.totalChunks > 0 ? Math.round((fVerified / f.totalChunks) * 10000) / 100 : 0;
							const fDownloadedSize = f.totalChunks > 0 ? formatSize(Math.round((f.rawSize * fVerified) / f.totalChunks)) : '0 B';
							return { ...f, verifiedChunks: fVerified, progress: fileProgress, downloadedSize: fDownloadedSize };
						});
					}
					const rawDownloadSpeed = data.bytesPerSecond ?? 0;
					return { ...d, status, progress, downloadedSize, downloadPeers: data.peers, downloadSpeed, rawDownloadSpeed, totalChunks: data.totalChunks, verifiedChunks: data.downloadedChunks, totalDownloadedBytes, files };
				})
			);
			// Reset stale timer — if no progress in 10s, clear speed/peers
			const prev = downloadStaleTimeouts.get(data.lishID);
			if (prev) clearTimeout(prev);
			downloadStaleTimeouts.set(data.lishID, setTimeout(() => {
				downloadStaleTimeouts.delete(data.lishID);
				downloads.update(list => list.map(d => {
					if (d.id !== data.lishID) return d;
					const status = isStatusLocked(d.status) ? d.status : computeStatus(false, activeUploadLishs.has(data.lishID));
					return { ...d, downloadPeers: 0, downloadSpeed: '0 B/s', rawDownloadSpeed: 0, status };
				}));
			}, 10000));
		});

		// transfer.download:disabled
		api.on('transfer.download:disabled', (data: { lishID: string }) => {
			disabledDownloads.add(data.lishID);
			activeDownloads.delete(data.lishID);
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				const status = isStatusLocked(d.status) ? d.status : computeStatus(false, activeUploadLishs.has(data.lishID));
				return { ...d, status, downloadEnabled: false, downloadSpeed: '0 B/s', rawDownloadSpeed: 0, downloadPeers: 0 };
			}));
		});

		// transfer.download:enabled — set flag and clear error state if present
		api.on('transfer.download:enabled', (data: { lishID: string }) => {
			disabledDownloads.delete(data.lishID);
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				return { ...d, downloadEnabled: true, ...(d.status === 'error' ? { status: 'idling' as DownloadStatus, errorCode: undefined, errorMessage: undefined } : {}), recoveryRetryCount: undefined, recoveryNextAt: undefined };
			}));
		});

		// transfer.download:complete
		api.on('transfer.download:complete', (data: { downloadDir: string; lishID: string; name?: string }) => {
			disabledDownloads.delete(data.lishID);
			activeDownloads.delete(data.lishID);
			const lish = get(downloads).find(d => d.id === data.lishID);
			if (lish) addNotification(tt('downloads.downloadComplete', { name: lish.name }), 'success');
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				const status = isStatusLocked(d.status) ? d.status : computeStatus(false, activeUploadLishs.has(data.lishID));
				const files = d.files.map(f => f.type !== 'file' ? f : { ...f, verifiedChunks: f.totalChunks, progress: 100, downloadedSize: formatSize(f.rawSize) });
				return { ...d, status, progress: 100, downloadedSize: d.size, directory: data.downloadDir, files };
			}));
		});

		// transfer.download:error
		api.on('transfer.download:error', (data: { error: string; errorDetail?: string; lishID: string }) => {
			const lish = get(downloads).find(d => d.id === data.lishID);
			if (lish) addNotification(tt('downloads.downloadError', { name: lish.name, error: data.errorDetail || data.error }), 'error');
			disabledDownloads.add(data.lishID);
			activeDownloads.delete(data.lishID);
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				return { ...d, status: 'error' as DownloadStatus, downloadEnabled: false, downloadPeers: 0, downloadSpeed: '0 B/s', rawDownloadSpeed: 0, errorCode: data.error, errorMessage: data.errorDetail || data.error };
			}));
		});

		// transfer.upload:progress — with stale timeout
		const uploadTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
		api.on('transfer.upload:progress', (data: { lishID: string; uploadedChunks: number; bytesPerSecond: number; peers: number }) => {
			activeUploadLishs.add(data.lishID);
			const prevUlChunks = lastUploadedChunks.get(data.lishID) ?? data.uploadedChunks;
			const deltaUlChunks = Math.max(0, data.uploadedChunks - prevUlChunks);
			lastUploadedChunks.set(data.lishID, data.uploadedChunks);
			downloads.update(list =>
				list.map(d => {
					if (d.id !== data.lishID) return d;
					const uploadSpeed = formatSize(data.bytesPerSecond) + '/s';
					const isDown = d.status === 'downloading' || d.status === 'downloading-uploading' || activeDownloads.has(data.lishID);
					const status = isStatusLocked(d.status) ? d.status : computeStatus(isDown, true);
					const totalUploadedBytes = d.totalUploadedBytes + (deltaUlChunks > 0 && d.chunkSize > 0 ? deltaUlChunks * d.chunkSize : 0);
					return { ...d, status, uploadPeers: data.peers, uploadSpeed, rawUploadSpeed: data.bytesPerSecond, totalUploadedBytes };
				})
			);
			// Reset stale timer — if no progress in 15s, clear upload state
			const prev = uploadTimeouts.get(data.lishID);
			if (prev) clearTimeout(prev);
			uploadTimeouts.set(data.lishID, setTimeout(() => {
				activeUploadLishs.delete(data.lishID);
				uploadTimeouts.delete(data.lishID);
				downloads.update(list => list.map(d => {
					if (d.id !== data.lishID) return d;
					return { ...d, uploadSpeed: '0 B/s', rawUploadSpeed: 0, uploadPeers: 0, status: isStatusLocked(d.status) ? d.status : computeStatus(activeDownloads.has(data.lishID), false) };
				}));
			}, 15000));
		});

		// transfer.upload:disabled
		api.on('transfer.upload:disabled', (data: { lishID: string }) => {
			activeUploadLishs.delete(data.lishID);
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				const status = isStatusLocked(d.status) ? d.status : computeStatus(activeDownloads.has(data.lishID), false);
				return { ...d, status, uploadEnabled: false, uploadSpeed: '0 B/s', rawUploadSpeed: 0, uploadPeers: 0 };
			}));
		});

		// transfer.upload:enabled — set flag and clear error state if present
		api.on('transfer.upload:enabled', (data: { lishID: string }) => {
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				return { ...d, uploadEnabled: true, ...(d.status === 'error' ? { status: 'idling' as DownloadStatus, errorCode: undefined, errorMessage: undefined } : {}), recoveryRetryCount: undefined, recoveryNextAt: undefined };
			}));
		});

		// transfer.upload:error — I/O error during upload (e.g. source directory missing)
		api.on('transfer.upload:error', (data: { lishID: string; error: string; errorDetail?: string }) => {
			const lish = get(downloads).find(d => d.id === data.lishID);
			if (lish) addNotification(tt('downloads.downloadError', { name: lish.name, error: data.errorDetail || data.error }), 'error');
			activeUploadLishs.delete(data.lishID);
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				return { ...d, status: 'error' as DownloadStatus, uploadEnabled: false, uploadPeers: 0, uploadSpeed: '0 B/s', rawUploadSpeed: 0, errorCode: data.error, errorMessage: data.errorDetail || data.error };
			}));
		});

		// transfer.recovery:scheduled — recovery timer started/rescheduled
		api.on('transfer.recovery:scheduled', (data: { lishID: string; delayMs: number; retryCount: number }) => {
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				return { ...d, recoveryRetryCount: data.retryCount, recoveryNextAt: Date.now() + data.delayMs };
			}));
		});

		// transfer.recovery:attempting — recovery attempt in progress
		api.on('transfer.recovery:attempting', (data: { lishID: string }) => {
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				return { ...d, recoveryNextAt: 0 };
			}));
		});

		// transfer.recovery:recovered — recovery succeeded
		api.on('transfer.recovery:recovered', (data: { lishID: string }) => {
			const lish = get(downloads).find(d => d.id === data.lishID);
			if (lish) addNotification(tt('downloads.recoverySuccess', { name: lish.name }), 'success');
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				return { ...d, recoveryRetryCount: undefined, recoveryNextAt: undefined };
			}));
		});

		// transfer.download:retrying — inline write retry in progress
		api.on('transfer.download:retrying', (data: { lishID: string; errorCode: string; errorDetail?: string; retryCount: number; maxRetries: number }) => {
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				return { ...d, status: 'retrying' as DownloadStatus, retryErrorCode: data.errorCode, retryCount: data.retryCount, retryMaxRetries: data.maxRetries };
			}));
		});

		// transfer.download:resumed — inline retry succeeded, back to downloading
		api.on('transfer.download:resumed', (data: { lishID: string }) => {
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				const status = d.downloadEnabled ? 'downloading' as DownloadStatus : 'idling' as DownloadStatus;
				return { ...d, status, retryErrorCode: undefined, retryCount: undefined, retryMaxRetries: undefined };
			}));
		});

		// transfer.upload:stopped — peer disconnected, upload stream ended (NOT user action)
		// Debounce: downloader closes stream between batches and reopens ~10s later.
		// Only reset to idling if no upload:progress arrives within 20s.
		api.on('transfer.upload:stopped', (data: { lishID: string }) => {
			const prev = uploadTimeouts.get(data.lishID);
			if (prev) clearTimeout(prev);
			uploadTimeouts.set(data.lishID, setTimeout(() => {
				activeUploadLishs.delete(data.lishID);
				uploadTimeouts.delete(data.lishID);
				downloads.update(list => list.map(d => {
					if (d.id !== data.lishID) return d;
					const status = isStatusLocked(d.status) ? d.status : computeStatus(activeDownloads.has(data.lishID), false);
					return { ...d, uploadSpeed: '0 B/s', rawUploadSpeed: 0, uploadPeers: 0, status };
				}));
			}, 20000));
		});
	}
	// Subscribe on every connect (backend has fresh subscribedEvents after reconnect)
	api.subscribe('lishs:add');
	api.subscribe('lishs:remove');
	api.subscribe('lishs:verify');
	api.subscribe('lishs:move');
	api.subscribe('lishs:move:status');
	api.subscribe('lishs:move:progress');
	api.subscribe('transfer.download:progress');
	api.subscribe('transfer.download:disabled');
	api.subscribe('transfer.download:enabled');
	api.subscribe('transfer.download:complete');
	api.subscribe('transfer.download:error');
	api.subscribe('transfer.upload:progress');
	api.subscribe('transfer.upload:disabled');
	api.subscribe('transfer.upload:enabled');
	api.subscribe('transfer.upload:stopped');
	api.subscribe('transfer.upload:error');
	api.subscribe('transfer.recovery:scheduled');
	api.subscribe('transfer.recovery:attempting');
	api.subscribe('transfer.recovery:recovered');
	api.subscribe('transfer.download:retrying');
	api.subscribe('transfer.download:resumed');
}

/** Reset verify state for a LISH in the downloads store (set all to 0, status to pending-verification). Skips if actively downloading. */
export function resetVerifyState(lishID: string): void {
	downloads.update(list =>
		list.map(d => {
			if (d.id !== lishID) return d;
			if (d.status === 'downloading' || d.status === 'downloading-uploading' || d.status === 'uploading' || d.status === 'allocating') return d;
			const files = d.files.map(f => (f.type !== 'file' ? f : { ...f, verifiedChunks: 0, progress: 0, downloadedSize: '0 B' }));
			return { ...d, verifiedChunks: 0, progress: 0, status: 'pending-verification' as DownloadStatus, files, downloadedSize: '0 B', errorCode: undefined, errorMessage: undefined };
		})
	);
}
/** Clear error state for a LISH (called when user acknowledges error or retries). */
export function clearError(lishID: string): void {
	downloads.update(list => list.map(d => {
		if (d.id !== lishID || d.status !== 'error') return d;
		return { ...d, status: 'idling' as DownloadStatus, errorCode: undefined, errorMessage: undefined };
	}));
}

/**
 * Add a catalog entry to the downloads store as an active "downloading" entry.
 * Called when catalog.startDownload returns status 'downloading'.
 */
export function addCatalogDownload(entry: { lishID: string; name: string; totalSize?: number; fileCount?: number }): void {
	activeDownloads.set(entry.lishID, Date.now());
	const existing = get(downloads);
	if (existing.some(d => d.id === entry.lishID)) return; // already tracked
	const dl: DownloadData = {
		id: entry.lishID,
		name: entry.name,
		progress: 0,
		size: entry.totalSize ? formatSize(entry.totalSize) : '?',
		rawTotalSize: entry.totalSize ?? 0,
		downloadedSize: '0 B',
		status: 'downloading',
		downloadEnabled: true,
		uploadEnabled: false,
		downloadPeers: 0,
		uploadPeers: 0,
		downloadSpeed: '-',
		rawDownloadSpeed: 0,
		uploadSpeed: '-',
		rawUploadSpeed: 0,
		files: [],
		verifiedChunks: 0,
		totalChunks: 0,
		chunkSize: 0,
		totalUploadedBytes: 0,
		totalDownloadedBytes: 0,
	};
	downloads.update(list => [dl, ...list]);
}

// Table columns definition
export const DOWNLOAD_TABLE_COLUMNS = '1fr 5vw 9vw 9vw 8vw 13vw 3vw 5vw 11vw';
// Toolbar action IDs for download detail view
export type DownloadToolbarActionID = 'back' | 'open-directory' | 'toggle-download' | 'toggle-upload' | 'verify' | 'stop-verify' | 'export' | 'move' | 'delete';
export interface DownloadToolbarAction {
	id: DownloadToolbarActionID;
	icon: string | ((downloadPaused: boolean, uploadPaused: boolean) => string);
	getLabel: (t: (key: string) => string, downloadPaused: boolean, uploadPaused: boolean) => string;
}
export const DOWNLOAD_TOOLBAR_ACTIONS: DownloadToolbarAction[] = [
	{ id: 'back', icon: '/img/back.svg', getLabel: t => t('common.back') },
	{ id: 'open-directory', icon: '/img/directory.svg', getLabel: t => t('common.openDirectory') },
	{ id: 'toggle-download', icon: dp => (dp ? '/img/play.svg' : '/img/pause.svg'), getLabel: (t, dp) => (dp ? t('downloads.enableDownload') : t('downloads.disableDownload')) },
	{ id: 'toggle-upload', icon: (_dp, up) => (up ? '/img/play.svg' : '/img/pause.svg'), getLabel: (t, _dp, up) => (up ? t('downloads.enableUpload') : t('downloads.disableUpload')) },
	{ id: 'verify', icon: '/img/check.svg', getLabel: t => t('downloads.verify') },
	{ id: 'stop-verify', icon: '/img/cross.svg', getLabel: t => t('downloads.stopVerify') },
	{ id: 'export', icon: '/img/upload.svg', getLabel: t => t('common.export') },
	{ id: 'move', icon: '/img/move.svg', getLabel: t => t('downloads.moveData') },
	{ id: 'delete', icon: '/img/del.svg', getLabel: t => t('common.delete') },
];

/**
 * Handle toolbar action for download detail
 * @returns true if action was handled internally, false if needs UI handling (e.g., onBack)
 */
export function handleDownloadToolbarAction(actionID: DownloadToolbarActionID): { handled: boolean; needsBack?: boolean; needsDelete?: boolean; needsExport?: boolean; needsVerify?: boolean; needsMove?: boolean } {
	switch (actionID) {
		case 'back':
			return { handled: false, needsBack: true };
		case 'open-directory':
			// TODO: Implement open directory in file browser
			return { handled: true };
		case 'toggle-download':
			// TODO: Implement toggle pause/resume download
			return { handled: true };
		case 'toggle-upload':
			// TODO: Implement toggle pause/resume upload
			return { handled: true };
		case 'verify':
			return { handled: false, needsVerify: true };
		case 'stop-verify':
			return { handled: true };
		case 'export':
			return { handled: false, needsExport: true };
		case 'move':
			return { handled: false, needsMove: true };
		case 'delete':
			return { handled: false, needsDelete: true };
		default:
			return { handled: false };
	}
}

/**
 * Delete a LISH and/or its data from the backend.
 * @param lishID - The LISH ID to delete
 * @param deleteLISH - Whether to delete the LISH entry from storage
 * @param deleteData - Whether to also delete the associated data directory
 * @returns true if deletion succeeded
 */
export async function deleteDownload(lishID: string, deleteLISH: boolean, deleteData: boolean): Promise<boolean> {
	try {
		const result = await api.lishs.delete(lishID, deleteLISH, deleteData);
		return result;
	} catch (err) {
		console.error('Failed to delete LISH:', err);
		return false;
	}
}

// Update the directory for a LISH in the downloads store.
export function updateDownloadDirectory(lishID: string, newDirectory: string): void {
	downloads.update(list => list.map(d => (d.id === lishID ? { ...d, directory: newDirectory } : d)));
}

// Set the moving status for a LISH in the downloads store.
export function setMovingStatus(lishID: string, moving: boolean): void {
	downloads.update(list => list.map(d => (d.id === lishID ? { ...d, status: moving ? ('moving' as DownloadStatus) : ('idling' as DownloadStatus) } : d)));
}
