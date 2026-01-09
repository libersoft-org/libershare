<script lang="ts">
	import ProgressBar from '../ProgressBar/ProgressBar.svelte';
	import DownloadFile from './DownloadFile.svelte';
	export interface DownloadFileData {
		id: number;
		name: string;
		progress: number;
		size: string;
		status: 'completed' | 'downloading' | 'waiting' | 'paused' | 'error';
	}
	interface Props {
		name: string;
		id: string;
		progress: number;
		size: string;
		downloadPeers: number;
		uploadPeers: number;
		downloadSpeed: string;
		uploadSpeed: string;
		files: DownloadFileData[];
		selected?: boolean;
		expanded?: boolean;
		selectedFileIndex?: number;
	}
	let { name, id, progress, size, downloadPeers, uploadPeers, downloadSpeed, uploadSpeed, files, selected = false, expanded = false, selectedFileIndex = -1 }: Props = $props();
	let isCompleted = $derived(progress >= 100);

	function truncateID(id: string): string {
		if (id.length <= 16) return id;
		return `${id.slice(0, 6)}...${id.slice(-6)}`;
	}
</script>

<style>
	.item {
		display: grid;
		grid-template-columns: 1fr 12vh 15vh 8vh 6vh 6vh 10vh 10vh;
		align-items: center;
		gap: 1vh;
		padding: 1vh 2vh;
		border-bottom: 0.4vh solid var(--secondary-softer-background);
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

	.item.selected .id {
		color: var(--primary-foreground);
	}

	.item .size {
		font-size: 1.5vh;
		color: var(--default-foreground);
		text-align: right;
	}

	.item .peers {
		font-size: 1.5vh;
		text-align: center;
	}

	.item .speed {
		font-size: 1.4vh;
		text-align: right;
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
</style>

<div class="item" class:selected={selected && selectedFileIndex === -1}>
	<div class="name">
		<span class="expand" class:expanded>▶</span>
		{name}
	</div>
	<div class="id">{truncateID(id)}</div>
	<ProgressBar {progress} completed={isCompleted} />
	<div class="size">{size}</div>
	<div class="peers download">{downloadPeers}</div>
	<div class="peers upload">{uploadPeers}</div>
	<div class="speed download">{downloadSpeed}</div>
	<div class="speed upload">{uploadSpeed}</div>
</div>

{#if expanded}
	<div class="files-wrapper">
		{#each files as file, index (file.id)}
			<DownloadFile name={file.name} progress={file.progress} size={file.size} status={file.status} selected={selected && selectedFileIndex === index} />
		{/each}
	</div>
{/if}
