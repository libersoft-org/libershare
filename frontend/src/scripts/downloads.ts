import { writable } from 'svelte/store';
import { type ILISHSummary, type ILISHDetail } from '@shared';
import { api } from './api.ts';
import { formatSize } from './utils.ts';

export type DownloadStatus = 'completed' | 'downloading' | 'waiting' | 'paused' | 'error';

export interface DownloadFileData {
	id: number;
	name: string;
	progress: number;
	size: string;
	downloadedSize?: string;
}

export interface DownloadData {
	id: string;
	name: string;
	progress: number;
	size: string;
	downloadedSize?: string;
	status: DownloadStatus;
	downloadPeers: number;
	uploadPeers: number;
	downloadSpeed: string;
	uploadSpeed: string;
	files: DownloadFileData[];
}

/**
 * Convert a backend ILISHSummary to frontend DownloadData (for list table).
 * Status, progress, peers, and speeds are mocked for now.
 */
function summaryToDownload(summary: ILISHSummary): DownloadData {
	return {
		id: summary.id,
		name: summary.name ?? summary.id,
		progress: 0,
		size: formatSize(summary.totalSize),
		downloadedSize: '0 B',
		status: 'waiting',
		downloadPeers: 0,
		uploadPeers: 0,
		downloadSpeed: '0 B/s',
		uploadSpeed: '0 B/s',
		files: [],
	};
}

/**
 * Convert a backend ILISHDetail to frontend DownloadData (for detail view).
 */
function detailToDownload(detail: ILISHDetail): DownloadData {
	return {
		id: detail.id,
		name: detail.name ?? detail.id,
		progress: 0,
		size: formatSize(detail.totalSize),
		downloadedSize: '0 B',
		status: 'waiting',
		downloadPeers: 0,
		uploadPeers: 0,
		downloadSpeed: '0 B/s',
		uploadSpeed: '0 B/s',
		files: detail.files.map((f, i) => ({
			id: i,
			name: f.path,
			progress: 0,
			size: formatSize(f.size),
			downloadedSize: '0 B',
		})),
	};
}

// --- List page stores ---

export const downloads = writable<DownloadData[]>([]);
export const downloadsLoading = writable<boolean>(true);

let listUnsub: (() => void) | null = null;

/**
 * Load download list from backend and subscribe to list changes.
 * Call when entering the Downloads page.
 */
export async function subscribeDownloadList(): Promise<void> {
	if (listUnsub) return;
	downloadsLoading.set(true);
	try {
		const summaries = await api.lishs.list();
		downloads.set(summaries.map(summaryToDownload));
	} catch (err) {
		console.error('Failed to load LISH list:', err);
		downloads.set([]);
	} finally {
		downloadsLoading.set(false);
	}

	listUnsub = api.on('lishs:list', (summaries: ILISHSummary[]) => {
		downloads.set(summaries.map(summaryToDownload));
	}) as () => void;
	await api.subscribe('lishs:list');
}

/**
 * Unsubscribe from download list changes.
 * Call when leaving the Downloads page.
 */
export async function unsubscribeDownloadList(): Promise<void> {
	if (!listUnsub) return;
	await api.unsubscribe('lishs:list');
	listUnsub();
	listUnsub = null;
}

// --- Detail page stores ---

export const selectedDownload = writable<DownloadData | null>(null);
export const selectedDownloadLoading = writable<boolean>(false);

let detailUnsub: (() => void) | null = null;

/**
 * Load download detail from backend and subscribe to detail changes.
 * Call when entering the Download detail page.
 */
export async function subscribeDownloadDetail(lishID: string): Promise<void> {
	if (detailUnsub) return;

	selectedDownloadLoading.set(true);
	try {
		const detail = await api.lishs.get(lishID);
		selectedDownload.set(detail ? detailToDownload(detail) : null);
	} catch (err) {
		console.error('Failed to load LISH detail:', err);
		selectedDownload.set(null);
	} finally {
		selectedDownloadLoading.set(false);
	}

	const eventName = `lishs:detail:${lishID}`;
	detailUnsub = api.on(eventName, (detail: ILISHDetail) => {
		selectedDownload.set(detailToDownload(detail));
	}) as () => void;
	await api.subscribe(eventName);
}

/**
 * Unsubscribe from download detail changes.
 * Call when leaving the Download detail page.
 */
export async function unsubscribeDownloadDetail(lishID: string): Promise<void> {
	if (!detailUnsub) return;
	await api.unsubscribe(`lishs:detail:${lishID}`);
	detailUnsub();
	detailUnsub = null;
	selectedDownload.set(null);
}
// Table columns definition
export const DOWNLOAD_TABLE_COLUMNS = '1fr 5vw 10vw 10vw 8vw 8vw 8vw 8vw 8vw';
// Toolbar action IDs for download detail view
export type DownloadToolbarActionId = 'back' | 'open-folder' | 'toggle' | 'export' | 'move' | 'delete';
export interface DownloadToolbarAction {
	id: DownloadToolbarActionId;
	icon: string;
	getLabel: (t: (key: string) => string, isPaused: boolean) => string;
	getIcon?: (isPaused: boolean) => string;
}
export const DOWNLOAD_TOOLBAR_ACTIONS: DownloadToolbarAction[] = [
	{ id: 'back', icon: '/img/back.svg', getLabel: t => t('common.back') },
	{ id: 'open-folder', icon: '/img/folder.svg', getLabel: t => t('common.openFolder') },
	{ id: 'toggle', icon: '/img/pause.svg', getLabel: (t, isPaused) => (isPaused ? t('downloads.start') : t('downloads.pause')), getIcon: isPaused => (isPaused ? '/img/play.svg' : '/img/pause.svg') },
	{ id: 'export', icon: '/img/upload.svg', getLabel: t => t('common.export') },
	{ id: 'move', icon: '/img/move.svg', getLabel: t => t('downloads.moveData') },
	{ id: 'delete', icon: '/img/del.svg', getLabel: t => t('common.delete') },
];

/**
 * Handle toolbar action for download detail
 * @returns true if action was handled internally, false if needs UI handling (e.g., onBack)
 */
export function handleDownloadToolbarAction(actionId: DownloadToolbarActionId, download: DownloadData | null): { handled: boolean; needsBack?: boolean; needsDelete?: boolean } {
	switch (actionId) {
		case 'back':
			return { handled: false, needsBack: true };
		case 'open-folder':
			// TODO: Implement open folder in file browser
			console.log('Open folder for download:', download?.id);
			return { handled: true };
		case 'toggle':
			// TODO: Implement toggle pause/resume
			console.log('Toggle pause/resume for download:', download?.id);
			return { handled: true };
		case 'export':
			// TODO: Implement export LISH
			console.log('Export LISH for download:', download?.id);
			return { handled: true };
		case 'move':
			// TODO: Implement move data
			console.log('Move data for download:', download?.id);
			return { handled: true };
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
