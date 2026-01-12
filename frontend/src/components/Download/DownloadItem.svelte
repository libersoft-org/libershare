<script lang="ts">
	import ProgressBar from '../ProgressBar/ProgressBar.svelte';
	import Badge from '../Badge/Badge.svelte';
	import Table from '../Table/Table.svelte';
	import TableRow from '../Table/TableRow.svelte';
	import TableCell from '../Table/TableCell.svelte';
	import DownloadFile from './DownloadFile.svelte';
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

	.details .row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.5vh 0;
		border-bottom: 0.2vh solid var(--secondary-softer-background);
	}

	.details .label {
		color: var(--disabled-foreground);
	}

	.details .value {
		font-weight: bold;
	}

	.details .progress-row {
		align-items: center;
	}

	.details .progress-value {
		flex: 1;
		max-width: 50%;
	}

	.details .badge {
		padding: 0.3vh 0.6vh;
		border: 0.2vh solid var(--secondary-softer-background);
		border-radius: 0.5vh;
		background-color: var(--secondary-background);
	}

	.files-wrapper {
		background-color: rgba(0, 0, 0, 0.2);
		padding-left: 1.5vh;
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
	<TableCell align="center" desktopOnly><Badge class={status}>{$t.downloads?.statuses?.[status]}</Badge></TableCell>
	<TableCell align="center" desktopOnly>{downloadPeers}</TableCell>
	<TableCell align="center" desktopOnly>{uploadPeers}</TableCell>
	<TableCell align="center" desktopOnly>{downloadSpeed}</TableCell>
	<TableCell align="center" desktopOnly>{uploadSpeed}</TableCell>
</TableRow>
{#if expanded}
	<div class="details" class:show={expanded}>
		<div class="row">
			<span class="label">{$t.downloads?.id}</span>
			<span class="value">{truncateID(id)}</span>
		</div>
		<div class="row">
			<span class="label">{$t.downloads?.size}</span>
			<span class="value">{size}</span>
		</div>
		<div class="row progress-row">
			<span class="label">{$t.downloads?.progress}</span>
			<span class="value progress-value"><ProgressBar {progress} /></span>
		</div>
		<div class="row">
			<span class="label">{$t.downloads?.status}</span>
			<Badge class={status}>{$t.downloads?.statuses?.[status]}</Badge>
		</div>
		<div class="row">
			<span class="label">{$t.downloads?.downloadingFrom}</span>
			<span class="value">{downloadPeers}</span>
		</div>
		<div class="row">
			<span class="label">{$t.downloads?.uploadingTo}</span>
			<span class="value">{uploadPeers}</span>
		</div>
		<div class="row">
			<span class="label">{$t.downloads?.downloadSpeed}</span>
			<span class="value">{downloadSpeed}</span>
		</div>
		<div class="row">
			<span class="label">{$t.downloads?.uploadSpeed}</span>
			<span class="value">{uploadSpeed}</span>
		</div>
	</div>
	<Table columns="1fr 10vh 20vh" columnsMobile="1fr 5vh 10vh" noBorder>
		{#each files as file, index (file.id)}
			<DownloadFile name={file.name} progress={file.progress} size={file.size} selected={selected && selectedFileIndex === index} odd={index % 2 === 0} />
		{/each}
	</Table>
{/if}
