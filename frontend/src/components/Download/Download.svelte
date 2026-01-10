<script lang="ts">
	import { onMount } from 'svelte';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import { t } from '../../scripts/language.ts';
	import DownloadItem, { type DownloadFileData, type DownloadStatus } from './DownloadItem.svelte';
	interface DownloadData {
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
	.download {
		display: flex;
		flex-direction: column;
		margin: 2vh;
		border: 0.4vh solid var(--secondary-softer-background);
		border-radius: 2vh;
		color: var(--secondary-foreground);
		box-shadow: 0 0 2vh var(--secondary-softer-background);
		overflow: hidden;
	}

	.header {
		display: grid;
		grid-template-columns: 1fr 5vw 5vw 10vw 8vw 8vw 8vw 8vw 8vw;
		gap: 2vh;
		padding: 1vh 2vh;
		background-color: var(--secondary-background);
		font-size: 1.6vh;
		font-weight: bold;
	}

	.header .cell {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.header .cell.center {
		text-align: center;
	}

	.header .cell.right {
		text-align: right;
	}

	@media (max-width: 1199px) {
		.header {
			grid-template-columns: 1fr;
		}

		.header .cell.desktop {
			display: none;
		}
	}

	.items {
		flex: 1;
		overflow-y: auto;
		font-size: 1.4vh;
	}
</style>

<div class="download">
	<div class="header">
		<div class="cell">{$t.downloads?.name}</div>
		<div class="cell center desktop">{$t.downloads?.id}</div>
		<div class="cell right desktop">{$t.downloads?.size}</div>
		<div class="cell center desktop">{$t.downloads?.progress}</div>
		<div class="cell center desktop">{$t.downloads?.status}</div>
		<div class="cell center desktop">{$t.downloads?.downloadingFrom}</div>
		<div class="cell center desktop">{$t.downloads?.uploadingTo}</div>
		<div class="cell right desktop">{$t.downloads?.downloadSpeed}</div>
		<div class="cell right desktop">{$t.downloads?.uploadSpeed}</div>
	</div>
	<div class="items">
		{#each downloads as download, index (download.id)}
			<div bind:this={itemElements[index]}>
				<DownloadItem name={download.name} id={download.id} progress={download.progress} size={download.size} status={download.status} downloadPeers={download.downloadPeers} uploadPeers={download.uploadPeers} downloadSpeed={download.downloadSpeed} uploadSpeed={download.uploadSpeed} files={download.files} selected={active && selectedIndex === index} expanded={expandedIndex === index} selectedFileIndex={selectedIndex === index ? selectedFileIndex : -1} isLast={index === downloads.length - 1} odd={index % 2 === 0} />
			</div>
		{/each}
	</div>
</div>
