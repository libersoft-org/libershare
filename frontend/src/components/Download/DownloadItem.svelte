<script lang="ts">
	import ProgressBar from '../ProgressBar/ProgressBar.svelte';
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
	}
	let { name, id, progress, size, status, downloadPeers, uploadPeers, downloadSpeed, uploadSpeed, files, selected = false, expanded = false, selectedFileIndex = -1, isLast = false }: Props = $props();

	function truncateID(id: string): string {
		if (id.length <= 16) return id;
		return `${id.slice(0, 6)}...${id.slice(-6)}`;
	}
</script>

<style>
	.item {
		display: grid;
		grid-template-columns: 1fr 5vw 5vw 10vw 8vw 8vw 8vw 8vw 8vw;
		align-items: center;
		gap: 2vh;
		padding: 1vh 2vh;
		border-bottom: 0.4vh solid var(--secondary-softer-background);
	}

	.item.last {
		border-bottom: none;
	}

	.item.selected {
		color: var(--primary-background);
		background-color: var(--primary-foreground);
	}

	.item .name {
		font-size: 2vh;
		font-weight: bold;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.item .status {
		text-align: center;
		padding: 0.3vh 0.6vh;
		border: 0.2vh solid var(--secondary-softer-background);
		border-radius: 0.5vh;
		background-color: var(--secondary-background);
		color: var(--secondary-foreground);
	}

	.files-wrapper {
		background-color: rgba(0, 0, 0, 0.2);
		padding: 0.5vh 0 0.5vh 4vh;
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

	.center {
		text-align: center;
	}

	.right {
		text-align: right;
	}
</style>

<div class="item" class:selected={selected && selectedFileIndex === -1} class:last={isLast}>
	<div class="name">
		<span class="expand" class:expanded>▶</span>
		<span>{name}</span>
	</div>
	<div class="center">{truncateID(id)}</div>
	<div class="right">{size}</div>
	<ProgressBar {progress} />
	<div class="status {status}">{$t.downloads?.statuses?.[status]}</div>
	<div class="center">{downloadPeers}</div>
	<div class="center">{uploadPeers}</div>
	<div class="center">{downloadSpeed}</div>
	<div class="center">{uploadSpeed}</div>
</div>

{#if expanded}
	<div class="files-wrapper">
		{#each files as file, index (file.id)}
			<DownloadFile name={file.name} progress={file.progress} size={file.size} selected={selected && selectedFileIndex === index} />
		{/each}
	</div>
{/if}
