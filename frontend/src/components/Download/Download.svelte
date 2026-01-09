<script lang="ts">
	import { onMount } from 'svelte';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import DownloadItem, { type DownloadFileData } from './DownloadItem.svelte';

	interface DownloadData {
		id: number;
		name: string;
		hash: string;
		progress: number;
		size: string;
		downloadPeers: number;
		uploadPeers: number;
		downloadSpeed: string;
		uploadSpeed: string;
		files: DownloadFileData[];
	}

	interface Props {
		areaID: string;
		title?: string;
		onBack?: () => void;
	}
	let { areaID, title = 'Downloads', onBack }: Props = $props();
	let active = $derived($activeArea === areaID);

	// Test data
	const downloads: DownloadData[] = [
		{
			id: 1,
			name: 'Ubuntu 24.04 LTS',
			hash: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0',
			progress: 67.5,
			size: '4.2 GB',
			downloadPeers: 12,
			uploadPeers: 5,
			downloadSpeed: '15.3 MB/s',
			uploadSpeed: '2.1 MB/s',
			files: [
				{ id: 1, name: 'ubuntu-24.04-desktop-amd64.iso', progress: 100, size: '4.1 GB', status: 'completed' },
				{ id: 2, name: 'SHA256SUMS', progress: 45, size: '1.2 KB', status: 'downloading' },
				{ id: 3, name: 'SHA256SUMS.gpg', progress: 0, size: '833 B', status: 'waiting' },
			],
		},
		{
			id: 2,
			name: 'Fedora Workstation 40',
			hash: 'b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1',
			progress: 100,
			size: '2.1 GB',
			downloadPeers: 0,
			uploadPeers: 8,
			downloadSpeed: '0 B/s',
			uploadSpeed: '8.7 MB/s',
			files: [{ id: 1, name: 'Fedora-Workstation-Live-x86_64-40.iso', progress: 100, size: '2.1 GB', status: 'completed' }],
		},
		{
			id: 3,
			name: 'Arch Linux 2024.01',
			hash: 'c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2',
			progress: 23.8,
			size: '850 MB',
			downloadPeers: 3,
			uploadPeers: 1,
			downloadSpeed: '1.2 MB/s',
			uploadSpeed: '256 KB/s',
			files: [{ id: 1, name: 'archlinux-2024.01.01-x86_64.iso', progress: 23.8, size: '850 MB', status: 'downloading' }],
		},
		{
			id: 4,
			name: 'Linux Mint 21.3',
			hash: 'd4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3',
			progress: 0,
			size: '2.8 GB',
			downloadPeers: 0,
			uploadPeers: 0,
			downloadSpeed: '0 B/s',
			uploadSpeed: '0 B/s',
			files: [
				{ id: 1, name: 'linuxmint-21.3-cinnamon-64bit.iso', progress: 0, size: '2.7 GB', status: 'waiting' },
				{ id: 2, name: 'sha256sum.txt', progress: 0, size: '104 B', status: 'waiting' },
			],
		},
	];

	let selectedIndex = $state(0);
	let expandedIndex = $state<number | null>(null);
	let selectedFileIndex = $state(-1); // -1 = main row selected, 0+ = file selected
	let itemElements: HTMLElement[] = $state([]);

	function scrollToSelected(): void {
		const element = itemElements[selectedIndex];
		if (element) {
			element.scrollIntoView({
				behavior: 'smooth',
				block: 'center',
			});
		}
	}

	const areaHandlers = {
		up: () => {
			if (expandedIndex === selectedIndex && selectedFileIndex > -1) {
				// Inside expanded item, move up in files
				selectedFileIndex--;
				return true;
			}
			if (selectedIndex > 0) {
				selectedIndex--;
				selectedFileIndex = -1;
				scrollToSelected();
				return true;
			}
			return false;
		},
		down: () => {
			if (expandedIndex === selectedIndex) {
				const filesCount = downloads[selectedIndex].files.length;
				if (selectedFileIndex < filesCount - 1) {
					// Move down in files
					selectedFileIndex++;
					return true;
				}
			}
			if (selectedIndex < downloads.length - 1) {
				selectedIndex++;
				selectedFileIndex = -1;
				scrollToSelected();
				return true;
			}
			return false;
		},
		left: () => false,
		right: () => false,
		confirmDown: () => {},
		confirmUp: () => {
			// Toggle expand/collapse
			if (expandedIndex === selectedIndex) {
				expandedIndex = null;
				selectedFileIndex = -1;
			} else {
				expandedIndex = selectedIndex;
				selectedFileIndex = -1;
			}
		},
		confirmCancel: () => {},
		back: () => {
			if (expandedIndex !== null) {
				expandedIndex = null;
				selectedFileIndex = -1;
			} else {
				onBack?.();
			}
		},
	};

	onMount(() => {
		const unregister = useArea(areaID, areaHandlers);
		activateArea(areaID);
		return unregister;
	});
</script>

<style>
	.download-manager {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		overflow: hidden;
	}

	.header {
		display: grid;
		grid-template-columns: 1fr 12vh 15vh 8vh 6vh 6vh 10vh 10vh;
		gap: 1vh;
		padding: 1vh 2vh;
		background-color: var(--secondary-background);
		color: var(--secondary-foreground);
		font-size: 1.4vh;
		font-weight: bold;
	}

	.header-cell {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.header-cell.center {
		text-align: center;
	}

	.header-cell.right {
		text-align: right;
	}

	.items-container {
		flex: 1;
		overflow-y: auto;
	}
</style>

<div class="download-manager">
	<div class="header">
		<div class="header-cell">Název</div>
		<div class="header-cell">Hash</div>
		<div class="header-cell center">Progress</div>
		<div class="header-cell right">Velikost</div>
		<div class="header-cell center">↓</div>
		<div class="header-cell center">↑</div>
		<div class="header-cell right">↓ Speed</div>
		<div class="header-cell right">↑ Speed</div>
	</div>
	<div class="items-container">
		{#each downloads as download, index (download.id)}
			<div bind:this={itemElements[index]}>
				<DownloadItem name={download.name} hash={download.hash} progress={download.progress} size={download.size} downloadPeers={download.downloadPeers} uploadPeers={download.uploadPeers} downloadSpeed={download.downloadSpeed} uploadSpeed={download.uploadSpeed} files={download.files} selected={active && selectedIndex === index} expanded={expandedIndex === index} selectedFileIndex={selectedIndex === index ? selectedFileIndex : -1} />
			</div>
		{/each}
	</div>
</div>
