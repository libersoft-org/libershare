import { writable } from 'svelte/store';
import type { DownloadStatus } from '../components/Download/DownloadItem.svelte';

export interface DownloadFileData {
	id: number;
	name: string;
	progress: number;
	size: string;
}

export interface DownloadData {
	id: string;
	name: string;
	progress: number;
	size: string;
	status: DownloadStatus;
	downloadPeers: number;
	uploadPeers: number;
	downloadSpeed: string;
	uploadSpeed: string;
	files: DownloadFileData[];
}

// Store for currently selected download (for detail view)
export const selectedDownload = writable<DownloadData | null>(null);
