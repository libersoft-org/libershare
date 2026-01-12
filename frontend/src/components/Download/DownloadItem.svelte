<script lang="ts">
	import ProgressBar from '../ProgressBar/ProgressBar.svelte';
	import Badge from '../Badge/Badge.svelte';
	import Table from '../Table/Table.svelte';
	import TableRow from '../Table/TableRow.svelte';
	import TableCell from '../Table/TableCell.svelte';
	import DownloadFile from './DownloadFile.svelte';
	import ItemDetail from './DownloadItemDetail.svelte';
	import { t } from '../../scripts/language.ts';
	export type DownloadStatus = 'completed' | 'downloading' | 'waiting' | 'paused' | 'error';
	export interface DownloadFileData {
		id: number;
		name: string;
		progress: number;
		size: string;
	}
	interface Props {
		name: string;
		id: string;
		progress: number;
		size: string;
		status: DownloadStatus;
		downloadPeers: number;
		uploadPeers: number;
		downloadSpeed: string;
		uploadSpeed: string;
		files: DownloadFileData[];
		selected?: boolean;
		expanded?: boolean;
		selectedFileIndex?: number;
		isLast?: boolean;
		odd?: boolean;
	}
	let { name, id, progress, size, status, downloadPeers, uploadPeers, downloadSpeed, uploadSpeed, files, selected = false, expanded = false, selectedFileIndex = -1, isLast = false, odd = false }: Props = $props();

	function truncateID(id: string): string {
		if (id.length <= 16) return id;
		return `${id.slice(0, 6)}...${id.slice(-6)}`;
	}
</script>

<style>
	.name {
		font-size: 2vh;
		font-weight: bold;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.details {
		display: none;
		padding: 0vh 1vh;
		font-size: 1.6vh;
	}

	.details .progress-value {
		flex: 1;
		max-width: 50%;
	}

	.expand {
		display: inline-block;
		margin-right: 1vh;
		transition: transform 0.2s ease;
		font-size: 1.4vh;
	}

	.expand.expanded {
		transform: rotate(90deg);
	}

	@media (max-width: 1199px) {
		:global(.desktop) {
			display: none !important;
		}

		.details.show {
			display: block;
		}
	}
</style>

<TableRow selected={selected && selectedFileIndex === -1} {odd}>
	<TableCell>
		<div class="name">
			<span class="expand" class:expanded>▶</span>
			<span>{name}</span>
		</div>
	</TableCell>
	<TableCell align="center" desktopOnly>{truncateID(id)}</TableCell>
	<TableCell align="right" desktopOnly>{size}</TableCell>
	<TableCell desktopOnly><ProgressBar {progress} /></TableCell>
	<TableCell align="center" desktopOnly><Badge label={$t.downloads?.statuses?.[status]} /></TableCell>
	<TableCell align="center" desktopOnly>{downloadPeers}</TableCell>
	<TableCell align="center" desktopOnly>{uploadPeers}</TableCell>
	<TableCell align="center" desktopOnly>{downloadSpeed}</TableCell>
	<TableCell align="center" desktopOnly>{uploadSpeed}</TableCell>
</TableRow>
{#if expanded}
	<div class="details" class:show={expanded}>
		<ItemDetail label={$t.downloads?.id}>{truncateID(id)}</ItemDetail>
		<ItemDetail label={$t.downloads?.size}>{size}</ItemDetail>
		<ItemDetail label={$t.downloads?.progress}><span class="progress-value"><ProgressBar {progress} /></span></ItemDetail>
		<ItemDetail label={$t.downloads?.status}><Badge label={$t.downloads?.statuses?.[status]} /></ItemDetail>
		<ItemDetail label={$t.downloads?.downloadingFrom}>{downloadPeers}</ItemDetail>
		<ItemDetail label={$t.downloads?.uploadingTo}>{uploadPeers}</ItemDetail>
		<ItemDetail label={$t.downloads?.downloadSpeed}>{downloadSpeed}</ItemDetail>
		<ItemDetail label={$t.downloads?.uploadSpeed}>{uploadSpeed}</ItemDetail>
	</div>
	<Table columns="1fr 10vh 20vh" columnsMobile="1fr 5vh 10vh" noBorder>
		{#each files as file, index (file.id)}
			<DownloadFile name={file.name} progress={file.progress} size={file.size} selected={selected && selectedFileIndex === index} odd={index % 2 === 0} />
		{/each}
	</Table>
{/if}
