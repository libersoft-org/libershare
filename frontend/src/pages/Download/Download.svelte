<script lang="ts">
	import { onMount } from 'svelte';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { t } from '../../scripts/language.ts';
	import { navigateTo } from '../../scripts/navigation.ts';
	import { selectedDownload, DOWNLOAD_TABLE_COLUMNS, TEST_DOWNLOADS } from '../../scripts/downloads.ts';
	import { scrollToElement } from '../../scripts/utils.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Table from '../../components/Table/Table.svelte';
	import Header from '../../components/Table/TableHeader.svelte';
	import Cell from '../../components/Table/TableCell.svelte';
	import DownloadItem from './DownloadItem.svelte';
	interface Props {
		areaID: string;
		position?: Position;
		title?: string;
		onBack?: () => void;
	}
	let { areaID, position = CONTENT_POSITIONS.main, title = 'Downloads', onBack }: Props = $props();
	let active = $derived($activeArea === areaID);
	const downloads = TEST_DOWNLOADS;
	let selectedIndex = $state(0);
	let itemElements: HTMLElement[] = $state([]);
	// Toolbar state
	let toolbarAreaID = $derived(`${areaID}-toolbar`);
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
		gap: 2vh;
		height: 100%;
		padding: 2vh;
	}

	.container {
		flex: 1;
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
	<ButtonBar>
		<Button icon="/img/plus.svg" label={$t('downloads.createLish')} selected={toolbarActive && selectedToolbarIndex === 0} />
		<Button icon="/img/download.svg" label={$t('common.import')} selected={toolbarActive && selectedToolbarIndex === 1} />
		<Button icon="/img/upload.svg" label={$t('common.exportAll')} selected={toolbarActive && selectedToolbarIndex === 2} />
	</ButtonBar>
	<div class="container">
		<Table columns={DOWNLOAD_TABLE_COLUMNS} noBorder>
			<Header fontSize="1.4vh">
				<Cell>{$t('downloads.name')}</Cell>
				<Cell align="center" desktopOnly>{$t('downloads.id')}</Cell>
				<Cell align="center" desktopOnly>{$t('downloads.size')}</Cell>
				<Cell align="center" desktopOnly>{$t('downloads.progress')}</Cell>
				<Cell align="center" desktopOnly>{$t('downloads.status')}</Cell>
				<Cell align="center" desktopOnly>{$t('downloads.downloadingFrom')}</Cell>
				<Cell align="center" desktopOnly>{$t('downloads.uploadingTo')}</Cell>
				<Cell align="center" desktopOnly>{$t('downloads.downloadSpeed')}</Cell>
				<Cell align="center" desktopOnly>{$t('downloads.uploadSpeed')}</Cell>
			</Header>
			<div class="items">
				{#each downloads as download, index (download.id)}
					<div bind:this={itemElements[index]}>
						<DownloadItem name={download.name} id={download.id} progress={download.progress} size={download.size} downloadedSize={download.downloadedSize} status={download.status} downloadPeers={download.downloadPeers} uploadPeers={download.uploadPeers} downloadSpeed={download.downloadSpeed} uploadSpeed={download.uploadSpeed} selected={active && selectedIndex === index} isLast={index === downloads.length - 1} odd={index % 2 === 0} />
					</div>
				{/each}
			</div>
		</Table>
	</div>
</div>
