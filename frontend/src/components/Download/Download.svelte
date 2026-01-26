<script lang="ts">
	import { onMount } from 'svelte';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { t } from '../../scripts/language.ts';
	import { navigateTo } from '../../scripts/navigation.ts';
	import { selectedDownload } from '../../scripts/downloads.ts';
	import { scrollToElement } from '../../scripts/utils.ts';
	import Button from '../Buttons/Button.svelte';
	import Table from '../Table/Table.svelte';
	import Header from '../Table/TableHeader.svelte';
	import Cell from '../Table/TableCell.svelte';
	import DownloadItem, { type DownloadFileData, type DownloadStatus } from './DownloadItem.svelte';
	const columns = '1fr 5vw 5vw 10vw 8vw 8vw 8vw 8vw 8vw';
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
		position?: Position;
		title?: string;
		onBack?: () => void;
	}
	let { areaID, position = CONTENT_POSITIONS.main, title = 'Downloads', onBack }: Props = $props();
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
	let itemElements: HTMLElement[] = $state([]);

	// Toolbar state
	let toolbarAreaID = `${areaID}-toolbar`;
	let toolbarActive = $derived($activeArea === toolbarAreaID);
	let selectedToolbarIndex = $state(0);

	const scrollToSelected = () => scrollToElement(itemElements, selectedIndex);

	function openDetail() {
		const download = downloads[selectedIndex];
		selectedDownload.set(download);
		navigateTo('download-detail', download.name || download.id);
	}

	const toolbarHandlers = {
		up: () => false,
		down: () => {
			activateArea(areaID);
			return true;
		},
		left: () => {
			if (selectedToolbarIndex > 0) {
				selectedToolbarIndex--;
				return true;
			}
			return false;
		},
		right: () => {
			if (selectedToolbarIndex < 2) {
				selectedToolbarIndex++;
				return true;
			}
			return false;
		},
		confirmDown: () => {},
		confirmUp: () => {
			if (selectedToolbarIndex === 0) navigateTo('create-lish');
			else if (selectedToolbarIndex === 1) navigateTo('import-lish');
			else if (selectedToolbarIndex === 2) navigateTo('export-all-lish');
		},
		confirmCancel: () => {},
		back: () => onBack?.(),
	};

	const areaHandlers = {
		up: () => {
			if (selectedIndex > 0) {
				selectedIndex--;
				scrollToSelected();
				return true;
			}
			// Move to toolbar
			activateArea(toolbarAreaID);
			return true;
		},
		down: () => {
			if (selectedIndex < downloads.length - 1) {
				selectedIndex++;
				scrollToSelected();
				return true;
			}
			return false;
		},
		left: () => false,
		right: () => false,
		confirmDown: () => {},
		confirmUp: () => {
			openDetail();
		},
		confirmCancel: () => {},
		back: () => onBack?.(),
	};

	onMount(() => {
		const unregisterToolbar = useArea(toolbarAreaID, toolbarHandlers, position);
		const unregister = useArea(areaID, areaHandlers, position);
		activateArea(toolbarAreaID);
		return () => {
			unregisterToolbar();
			unregister();
		};
	});
</script>

<style>
	.download {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.toolbar {
		display: flex;
		flex-direction: row;
		flex-wrap: wrap;
		gap: 1vh;
		padding: 1vh 2vh;
	}

	.container {
		flex: 1;
		margin: 0 2vh;
		border: 0.4vh solid var(--secondary-softer-background);
		border-radius: 2vh;
		overflow: hidden;
	}

	.items {
		flex: 1;
		overflow-y: auto;
		font-size: 1.4vh;
	}
</style>

<div class="download">
	<div class="toolbar">
		<Button icon="/img/plus.svg" label={$t.downloads?.createLish} selected={toolbarActive && selectedToolbarIndex === 0} />
		<Button icon="/img/download.svg" label={$t.common?.import} selected={toolbarActive && selectedToolbarIndex === 1} />
		<Button icon="/img/upload.svg" label={$t.common?.exportAll} selected={toolbarActive && selectedToolbarIndex === 2} />
	</div>
	<div class="container">
		<Table {columns} noBorder>
		<Header fontSize="1.4vh">
			<Cell>{$t.downloads?.name}</Cell>
			<Cell align="center" desktopOnly>{$t.downloads?.id}</Cell>
			<Cell align="right" desktopOnly>{$t.downloads?.size}</Cell>
			<Cell align="center" desktopOnly>{$t.downloads?.progress}</Cell>
			<Cell align="center" desktopOnly>{$t.downloads?.status}</Cell>
			<Cell align="center" desktopOnly>{$t.downloads?.downloadingFrom}</Cell>
			<Cell align="center" desktopOnly>{$t.downloads?.uploadingTo}</Cell>
			<Cell align="right" desktopOnly>{$t.downloads?.downloadSpeed}</Cell>
			<Cell align="right" desktopOnly>{$t.downloads?.uploadSpeed}</Cell>
		</Header>
		<div class="items">
			{#each downloads as download, index (download.id)}
				<div bind:this={itemElements[index]}>
					<DownloadItem name={download.name} id={download.id} progress={download.progress} size={download.size} status={download.status} downloadPeers={download.downloadPeers} uploadPeers={download.uploadPeers} downloadSpeed={download.downloadSpeed} uploadSpeed={download.uploadSpeed} selected={active && selectedIndex === index} isLast={index === downloads.length - 1} odd={index % 2 === 0} />
				</div>
			{/each}
		</div>
		</Table>
	</div>
</div>
