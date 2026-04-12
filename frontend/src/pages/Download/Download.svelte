<script lang="ts">
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { t } from '../../scripts/language.ts';
	import { navigateTo } from '../../scripts/navigation.ts';
	import { downloads, downloadsLoading, DOWNLOAD_TABLE_COLUMNS, type DownloadStatus, computeEnabledMode } from '../../scripts/downloads.ts';
	import { api } from '../../scripts/api.ts';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Table from '../../components/Table/Table.svelte';
	import Header from '../../components/Table/TableHeader.svelte';
	import Cell from '../../components/Table/TableCell.svelte';
	import DownloadItem from './DownloadItem.svelte';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	import Input from '../../components/Input/Input.svelte';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { activateArea } from '../../scripts/areas.ts';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		title?: string | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = CONTENT_POSITIONS.main, onBack }: Props = $props();
	let showVerifyAllDialog = $state(false);
	let search = $state('');
	let anyDownloadEnabled = $derived($downloads.some(d => d.downloadEnabled));
	let anyUploadEnabled = $derived($downloads.some(d => d.uploadEnabled));
	let allDownloadDisabled = $derived(!anyDownloadEnabled);
	let allUploadDisabled = $derived(!anyUploadEnabled);

	const busyStatuses: DownloadStatus[] = ['moving', 'verifying', 'pending-verification', 'error', 'retrying'];

	function toggleAllDownloads(): void {
		if (allDownloadDisabled) {
			for (const d of $downloads) {
				if (!d.downloadEnabled && !busyStatuses.includes(d.status)) {
					api.call('transfer.enableDownload', { lishID: d.id });
				}
			}
		} else {
			for (const d of $downloads) {
				if (d.downloadEnabled) {
					api.call('transfer.disableDownload', { lishID: d.id });
				}
			}
		}
	}

	function toggleAllUploads(): void {
		if (allUploadDisabled) {
			for (const d of $downloads) {
				if (!d.uploadEnabled && !busyStatuses.includes(d.status)) {
					api.call('transfer.enableUpload', { lishID: d.id });
				}
			}
		} else {
			for (const d of $downloads) {
				if (d.uploadEnabled) {
					api.call('transfer.disableUpload', { lishID: d.id });
				}
			}
		}
	}
	let anyVerifying = $derived($downloads.some(d => d.status === 'verifying' || d.status === 'pending-verification'));
	let filteredDownloads = $derived(
		search.trim()
			? $downloads.filter(d => {
					const q = search.trim().toLowerCase();
					return d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q);
				})
			: $downloads
	);

	createNavArea(() => ({ areaID, position, onBack, activate: true }));

	function closeVerifyAllDialog(): void {
		showVerifyAllDialog = false;
		activateArea(areaID);
	}

	function openDetail(download: (typeof $downloads)[number]): void {
		navigateTo('download-detail', download.name || download.id, { lishID: download.id });
	}
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
		<Button icon={allDownloadDisabled ? '/img/play.svg' : '/img/pause.svg'} label={allDownloadDisabled ? $t('downloads.enableDownloadAll') : $t('downloads.disableDownloadAll')} position={[3, 0]} onConfirm={toggleAllDownloads} />
		<Button icon={allUploadDisabled ? '/img/play.svg' : '/img/pause.svg'} label={allUploadDisabled ? $t('downloads.enableUploadAll') : $t('downloads.disableUploadAll')} position={[4, 0]} onConfirm={toggleAllUploads} />
		<Button icon="/img/check.svg" label={$t('downloads.verifyAll')} position={[5, 0]} onConfirm={() => (showVerifyAllDialog = true)} />
		{#if anyVerifying}
			<Button icon="/img/cross.svg" label={$t('downloads.stopVerifyAll')} position={[6, 0]} onConfirm={() => api.lishs.stopVerifyAll()} />
		{/if}
	</ButtonBar>
	<Input bind:value={search} placeholder={$t('common.search') + ' ...'} fontSize="2vh" position={[0, 1]} />
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
					<Cell align="center" desktopOnly>{$t('downloads.transferred')}</Cell>
					<Cell align="center" desktopOnly>{$t('downloads.mode')}</Cell>
					<Cell align="center" desktopOnly>{$t('downloads.peers')}</Cell>
					<Cell align="center" desktopOnly>{$t('downloads.speed')}</Cell>
				</Header>
				<div class="items">
					{#each filteredDownloads as download, index (download.id)}
						<DownloadItem name={download.name} id={download.id} progress={download.progress} size={download.size} downloadedSize={download.downloadedSize} status={download.status} enabledMode={computeEnabledMode(download.downloadEnabled, download.uploadEnabled)} downloadPeers={download.downloadPeers} uploadPeers={download.uploadPeers} downloadSpeed={download.downloadSpeed} uploadSpeed={download.uploadSpeed} totalUploadedBytes={download.totalUploadedBytes} totalDownloadedBytes={download.totalDownloadedBytes} position={[0, index + 2]} onConfirm={() => openDetail(download)} isLast={index === filteredDownloads.length - 1} />
					{/each}
				</div>
			</Table>
		</div>
	{/if}
</div>
{#if showVerifyAllDialog}
	<ConfirmDialog
		title={$t('downloads.verifyAll')}
		message={$t('downloads.verifyAllConfirm')}
		confirmLabel={$t('common.yes')}
		cancelLabel={$t('common.no')}
		confirmIcon="/img/check.svg"
		cancelIcon="/img/cross.svg"
		{position}
		onConfirm={() => {
			closeVerifyAllDialog();
			api.lishs.verifyAll();
		}}
		onBack={closeVerifyAllDialog}
	/>
{/if}
