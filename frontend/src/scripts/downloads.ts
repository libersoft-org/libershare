import { writable } from 'svelte/store';
export type DownloadStatus = 'completed' | 'downloading' | 'waiting' | 'paused' | 'error';

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
// Table columns definition
export const DOWNLOAD_TABLE_COLUMNS = '1fr 5vw 5vw 10vw 8vw 8vw 8vw 8vw 8vw';
// Toolbar action IDs for download detail view
export type DownloadToolbarActionId = 'back' | 'open-folder' | 'toggle' | 'export' | 'move' | 'delete';
export interface DownloadToolbarAction {
	id: DownloadToolbarActionId;
	icon: string;
	getLabel: (t: { common?: { back?: string; export?: string; delete?: string }; downloads?: { openFolder?: string; start?: string; pause?: string; moveData?: string } }, isPaused: boolean) => string | undefined;
	getIcon?: (isPaused: boolean) => string;
}
export const DOWNLOAD_TOOLBAR_ACTIONS: DownloadToolbarAction[] = [
	{ id: 'back', icon: '/img/back.svg', getLabel: t => t.common?.back },
	{ id: 'open-folder', icon: '/img/folder.svg', getLabel: t => t.downloads?.openFolder },
	{ id: 'toggle', icon: '/img/pause.svg', getLabel: (t, isPaused) => isPaused ? t.downloads?.start : t.downloads?.pause, getIcon: isPaused => (isPaused ? '/img/play.svg' : '/img/pause.svg') },
	{ id: 'export', icon: '/img/upload.svg', getLabel: t => t.common?.export },
	{ id: 'move', icon: '/img/move.svg', getLabel: t => t.downloads?.moveData },
	{ id: 'delete', icon: '/img/del.svg', getLabel: t => t.common?.delete },
];
// Test data for development
export const TEST_DOWNLOADS: DownloadData[] = [
	{
		id: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0',
		name: 'Ubuntu 24.04 LTS',
		progress: 50,
		size: '4.2 GB',
		status: 'downloading',
		downloadPeers: 12,
		uploadPeers: 5,
		downloadSpeed: '15.3 MB/s',
		uploadSpeed: '2.1 MB/s',
		files: [
			{ id: 1, name: 'ubuntu-24.04-desktop-amd64.iso', progress: 100, size: '4.1 GB' },
			{ id: 2, name: 'SHA256SUMS', progress: 45, size: '1.2 KB' },
			{ id: 3, name: 'SHA256SUMS.gpg', progress: 0, size: '833 B' },
		],
	},
	{
		id: 'b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1',
		name: 'Fedora Workstation 40',
		progress: 100,
		size: '2.1 GB',
		status: 'completed',
		downloadPeers: 0,
		uploadPeers: 8,
		downloadSpeed: '0 B/s',
		uploadSpeed: '8.7 MB/s',
		files: [{ id: 1, name: 'Fedora-Workstation-Live-x86_64-40.iso', progress: 100, size: '2.1 GB' }],
	},
	{
		id: 'c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2',
		name: 'Arch Linux 2024.01',
		progress: 45.7,
		size: '850 MB',
		status: 'downloading',
		downloadPeers: 3,
		uploadPeers: 1,
		downloadSpeed: '1.2 MB/s',
		uploadSpeed: '256 KB/s',
		files: [{ id: 1, name: 'archlinux-2024.01.01-x86_64.iso', progress: 23.8, size: '850 MB' }],
	},
	{
		id: 'd4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3',
		name: 'Linux Mint 21.3',
		progress: 0,
		size: '2.8 GB',
		status: 'waiting',
		downloadPeers: 0,
		uploadPeers: 0,
		downloadSpeed: '0 B/s',
		uploadSpeed: '0 B/s',
		files: [
			{ id: 1, name: 'linuxmint-21.3-cinnamon-64bit.iso', progress: 0, size: '2.7 GB' },
			{ id: 2, name: 'sha256sum.txt', progress: 0, size: '104 B' },
		],
	},
];
