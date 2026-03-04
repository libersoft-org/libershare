<script lang="ts">
	import { onMount } from 'svelte';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { t } from '../../scripts/language.ts';
	import { navigateTo } from '../../scripts/navigation.ts';
	import { selectedDownload, downloads, downloadsLoading, subscribeDownloadList, unsubscribeDownloadList, DOWNLOAD_TABLE_COLUMNS } from '../../scripts/downloads.ts';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Table from '../../components/Table/Table.svelte';
	import Header from '../../components/Table/TableHeader.svelte';
	import Cell from '../../components/Table/TableCell.svelte';
	import DownloadItem from './DownloadItem.svelte';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		title?: string | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = CONTENT_POSITIONS.main, onBack }: Props = $props();

	createNavArea(areaID, position, { onBack, activate: true });

	function openDetail(index: number): void {
		const download = $downloads[index]!;
		selectedDownload.set(download);
		navigateTo('download-detail', download.name || download.id);
	}

	onMount(() => {
		subscribeDownloadList();
		return () => {
			unsubscribeDownloadList();
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
		box-sizing: border-box;
		overflow: hidden;
	}

	.container {
		flex: 1;
		min-height: 0;
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
		<Button icon="/img/plus.svg" label={$t('downloads.createLISH')} position={[0, 0]} onConfirm={() => navigateTo('create-lish')} />
		<Button icon="/img/download.svg" label={$t('common.import')} position={[1, 0]} onConfirm={() => navigateTo('import-lish')} />
		<Button icon="/img/upload.svg" label={$t('common.exportAll')} position={[2, 0]} onConfirm={() => navigateTo('export-all-lish')} />
	</ButtonBar>
	{#if $downloadsLoading}
		<Spinner size="8vh" />
	{:else}
		<div class="container">
			<Table columns={DOWNLOAD_TABLE_COLUMNS} noBorder>
				<Header fontSize="1.4vh">
					<Cell>{$t('common.name')}</Cell>
					<Cell align="center" desktopOnly>{$t('downloads.id')}</Cell>
					<Cell align="center" desktopOnly>{$t('common.size')}</Cell>
					<Cell align="center" desktopOnly>{$t('common.progress')}</Cell>
					<Cell align="center" desktopOnly>{$t('common.status')}</Cell>
					<Cell align="center" desktopOnly>{$t('downloads.downloadingFrom')}</Cell>
					<Cell align="center" desktopOnly>{$t('downloads.uploadingTo')}</Cell>
					<Cell align="center" desktopOnly>{$t('downloads.downloadSpeed')}</Cell>
					<Cell align="center" desktopOnly>{$t('downloads.uploadSpeed')}</Cell>
				</Header>
				<div class="items">
					{#each $downloads as download, index (download.id)}
						<DownloadItem name={download.name} id={download.id} progress={download.progress} size={download.size} downloadedSize={download.downloadedSize} status={download.status} downloadPeers={download.downloadPeers} uploadPeers={download.uploadPeers} downloadSpeed={download.downloadSpeed} uploadSpeed={download.uploadSpeed} position={[0, index + 1]} onConfirm={() => openDetail(index)} isLast={index === $downloads.length - 1} odd={index % 2 === 0} />
					{/each}
				</div>
			</Table>
		</div>
	{/if}
</div>
