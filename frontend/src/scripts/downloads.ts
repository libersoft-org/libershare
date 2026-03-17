import { writable, get } from 'svelte/store';
import { type ILISHDetail } from '@shared';
import { api } from './api.ts';
import { formatSize } from './utils.ts';
import { navigateBack } from './navigation.ts';
import { addNotification } from './notifications.ts';
import { tt } from './language.ts';

export type DownloadStatus = 'downloading' | 'uploading' | 'downloading-uploading' | 'idling' | 'verifying' | 'pending-verification' | 'moving';

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
	downloadPeers: number;
	uploadPeers: number;
	downloadSpeed: string;
	uploadSpeed: string;
	files: DownloadFileData[];
	verifiedChunks: number;
	totalChunks: number;
	chunkSize: number;
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
		downloadPeers: 0,
		uploadPeers: 0,
		downloadSpeed: '0 B/s',
		uploadSpeed: '0 B/s',
		files,
		verifiedChunks: detail.verifiedChunks,
		totalChunks: detail.totalChunks,
		chunkSize: detail.chunkSize,
	};
}

// ============================================================================
// Stores
// ============================================================================

let handlersRegistered = false;
let currentDetailLISHID: string | null = null;

export const downloads = writable<DownloadData[]>([]);
export const downloadsLoading = writable<boolean>(true);
// Track which LISHs are actively downloading (by lishID → last progress timestamp)
const activeDownloads = new Map<string, number>();
// Track explicitly paused downloads (prevents progress events from overriding paused state)
const pausedDownloads = new Set<string>();

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
	try {
		const { items: summaries, verifying: v, pendingVerification: pv, moving: mv } = await api.lishs.list(undefined, 'desc');
		verifying = v;
		pendingVerification = pv;
		moving = mv;
		const details = await Promise.all(summaries.map(s => api.lishs.get(s.id)));
		downloads.set(
			details
				.filter((d): d is ILISHDetail => d !== null)
				.map(d => {
					const entry = detailToDownload(d);
					if (moving.includes(d.id)) entry.status = 'moving';
					else if (d.id === verifying) entry.status = 'verifying';
					else if (pendingVerification.includes(d.id)) entry.status = 'pending-verification';
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
	try {
		const transfers = await api.call('transfer.getActiveTransfers', {}) as { lishID: string; type: 'downloading' | 'uploading' | 'upload-paused' | 'upload-enabled'; peers: number; bytesPerSecond: number }[];
		if (transfers?.length) {
			downloads.update(list => list.map(d => {
				const t = transfers.find(t => t.lishID === d.id);
				if (!t) return d;
				if (t.type === 'uploading') return { ...d, status: 'uploading' as DownloadStatus, uploadPeers: t.peers, uploadSpeed: formatSize(t.bytesPerSecond) + '/s' };
				if (t.type === 'upload-enabled') return { ...d, status: 'uploading' as DownloadStatus };
				if (t.type === 'downloading') return { ...d, status: 'downloading' as DownloadStatus };
				return d;
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
						entry.downloadedSize = existing.downloadedSize;
					}
					const updated = [...list];
					updated[idx] = entry;
					return updated;
				}
				// New entry — if active download, set status
				if (isActive) entry.status = 'downloading';
				addNotification(tt('downloads.lishAdded', { name: detail.name ?? detail.id }));
				return [entry, ...list];
			});
		});

		// lishs:remove — LISH deleted (broadcast from backend)
		api.on('lishs:remove', (data: { lishID: string }) => {
			if (currentDetailLISHID === data.lishID) navigateBack();
			downloads.update(list => list.filter(d => d.id !== data.lishID));
		});

		// lishs:verify — verification progress (broadcast from backend)
		api.on('lishs:verify', (data: { lishID: string; filePath: string; verifiedChunks: number; done?: boolean; reset?: boolean; queued?: boolean; started?: boolean }) => {
			// console.log('[downloads] lishs:verify received:', data.filePath, 'verified:', data.verifiedChunks, 'done:', data.done);
			if (data.reset) {
				resetVerifyState(data.lishID);
				return;
			}
			if (data.queued) {
				downloads.update(list =>
					list.map(d => {
						if (d.id !== data.lishID || d.status === 'moving') return d;
						return { ...d, status: 'pending-verification' as DownloadStatus };
					})
				);
				return;
			}
			if (data.started) {
				downloads.update(list =>
					list.map(d => {
						if (d.id !== data.lishID || d.status === 'moving') return d;
						return { ...d, status: 'verifying' as DownloadStatus };
					})
				);
				return;
			}
			if (data.done) {
				// Verification finished — recalculate status from final chunk counts
				const lish = get(downloads).find(d => d.id === data.lishID);
				if (lish && lish.status !== 'moving') addNotification(tt('downloads.verifyDone', { name: lish.name }));
				downloads.update(list =>
					list.map(d => {
						if (d.id !== data.lishID) return d;
						if (d.status === 'moving') return d; // Don't overwrite moving status
						const status: DownloadStatus = 'idling';
						const progress = d.totalChunks === 0 ? 100 : d.progress;
						return { ...d, status, progress };
					})
				);
				return;
			}
			downloads.update(list =>
				list.map(d => {
					if (d.id !== data.lishID || d.status === 'moving') return d;
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
			if (lish) addNotification(tt('downloads.moveSuccess', { name: lish.name }));
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

		// Helper: compute combined status from download/upload flags
		function computeStatus(isDown: boolean, isUp: boolean): DownloadStatus {
			if (isDown && isUp) return 'downloading-uploading';
			if (isDown) return 'downloading';
			if (isUp) return 'uploading';
			return 'idling';
		}

		// Track which LISHs are uploading (set by upload:progress, cleared by timeout)
		const activeUploadLishs = new Set<string>();

		// transfer.download:progress
		api.on('transfer.download:progress', (data: { lishID: string; downloadedChunks: number; totalChunks: number; peers: number; bytesPerSecond?: number }) => {
			if (pausedDownloads.has(data.lishID)) return;
			const isActive = data.peers > 0;
			if (isActive) activeDownloads.set(data.lishID, Date.now());
			else activeDownloads.delete(data.lishID);
			downloads.update(list =>
				list.map(d => {
					if (d.id !== data.lishID) return d;
					const progress = data.totalChunks > 0 ? Math.round((data.downloadedChunks / data.totalChunks) * 10000) / 100 : 0;
					const downloadedSize = d.rawTotalSize > 0 ? formatSize(Math.round((d.rawTotalSize * data.downloadedChunks) / data.totalChunks)) : '?';
					const downloadSpeed = isActive && data.bytesPerSecond ? formatSize(data.bytesPerSecond) + '/s' : '0 B/s';
					const status = computeStatus(isActive, activeUploadLishs.has(data.lishID));
					return { ...d, status, progress, downloadedSize, downloadPeers: data.peers, downloadSpeed, totalChunks: data.totalChunks, verifiedChunks: data.downloadedChunks };
				})
			);
		});

		// transfer.download:paused
		api.on('transfer.download:paused', (data: { lishID: string }) => {
			pausedDownloads.add(data.lishID);
			activeDownloads.delete(data.lishID);
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				const status = computeStatus(false, activeUploadLishs.has(data.lishID));
				return { ...d, status, downloadSpeed: '0 B/s' };
			}));
		});

		// transfer.download:resumed
		api.on('transfer.download:resumed', (data: { lishID: string }) => {
			pausedDownloads.delete(data.lishID);
			activeDownloads.set(data.lishID, Date.now());
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				const status = computeStatus(true, activeUploadLishs.has(data.lishID));
				return { ...d, status };
			}));
		});

		// transfer.download:complete
		api.on('transfer.download:complete', (data: { downloadDir: string; lishID: string; name?: string }) => {
			pausedDownloads.delete(data.lishID);
			activeDownloads.delete(data.lishID);
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				const status = computeStatus(false, activeUploadLishs.has(data.lishID));
				return { ...d, status, progress: 100, downloadedSize: d.size, directory: data.downloadDir };
			}));
		});

		// transfer.download:error
		api.on('transfer.download:error', (data: { error: string; errorDetail?: string; lishID: string }) => {
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				const status = computeStatus(false, activeUploadLishs.has(data.lishID));
				return { ...d, status };
			}));
		});

		// transfer.upload:progress — with stale timeout
		const uploadTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
		api.on('transfer.upload:progress', (data: { lishID: string; uploadedChunks: number; bytesPerSecond: number; peers: number }) => {
			activeUploadLishs.add(data.lishID);
			downloads.update(list =>
				list.map(d => {
					if (d.id !== data.lishID) return d;
					const uploadSpeed = formatSize(data.bytesPerSecond) + '/s';
					const isDown = d.status === 'downloading' || d.status === 'downloading-uploading' || activeDownloads.has(data.lishID);
					const status = computeStatus(isDown, true);
					return { ...d, status, uploadPeers: data.peers, uploadSpeed };
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
					return { ...d, uploadSpeed: '0 B/s', uploadPeers: 0, status: computeStatus(activeDownloads.has(data.lishID), false) };
				}));
			}, 15000));
		});

		// transfer.upload:paused
		api.on('transfer.upload:paused', (data: { lishID: string }) => {
			activeUploadLishs.delete(data.lishID);
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				const status = computeStatus(activeDownloads.has(data.lishID), false);
				return { ...d, status, uploadSpeed: '0 B/s', uploadPeers: 0 };
			}));
		});

		// transfer.upload:resumed
		api.on('transfer.upload:resumed', (data: { lishID: string }) => {
			activeUploadLishs.add(data.lishID);
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				const status = computeStatus(activeDownloads.has(data.lishID), true);
				return { ...d, status };
			}));
		});

		// transfer.upload:stopped — peer disconnected, upload stream ended (NOT user action)
		// Only reset speed/peers, do NOT change upload enabled state
		api.on('transfer.upload:stopped', (data: { lishID: string }) => {
			activeUploadLishs.delete(data.lishID);
			downloads.update(list => list.map(d => {
				if (d.id !== data.lishID) return d;
				return { ...d, uploadSpeed: '0 B/s', uploadPeers: 0 };
			}));
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
	api.subscribe('transfer.download:paused');
	api.subscribe('transfer.download:resumed');
	api.subscribe('transfer.download:complete');
	api.subscribe('transfer.download:error');
	api.subscribe('transfer.upload:progress');
	api.subscribe('transfer.upload:paused');
	api.subscribe('transfer.upload:resumed');
	api.subscribe('transfer.upload:stopped');
}

/** Reset verify state for a LISH in the downloads store (set all to 0, status to pending-verification). */
export function resetVerifyState(lishID: string): void {
	downloads.update(list =>
		list.map(d => {
			if (d.id !== lishID) return d;
			const files = d.files.map(f => (f.type !== 'file' ? f : { ...f, verifiedChunks: 0, progress: 0, downloadedSize: '0 B' }));
			return { ...d, verifiedChunks: 0, progress: 0, status: 'pending-verification' as DownloadStatus, files, downloadedSize: '0 B' };
		})
	);
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
		downloadPeers: 0,
		uploadPeers: 0,
		downloadSpeed: '-',
		uploadSpeed: '-',
		files: [],
		verifiedChunks: 0,
		totalChunks: 0,
		chunkSize: 0,
	};
	downloads.update(list => [dl, ...list]);
}

// Table columns definition
export const DOWNLOAD_TABLE_COLUMNS = '1fr 5vw 10vw 10vw 8vw 8vw 8vw 8vw 8vw';
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
