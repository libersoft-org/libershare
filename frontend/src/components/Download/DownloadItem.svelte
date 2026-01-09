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
		hash: string;
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
	let { name, hash, progress, size, downloadPeers, uploadPeers, downloadSpeed, uploadSpeed, files, selected = false, expanded = false, selectedFileIndex = -1 }: Props = $props();

	function truncateHash(hash: string): string {
		if (hash.length <= 16) return hash;
		return `${hash.slice(0, 6)}...${hash.slice(-6)}`;
	}

	let isCompleted = $derived(progress >= 100);
</script>

<style>
	.item-wrapper {
		border-bottom: 1px solid var(--disabled-background);
	}

	.item {
		display: grid;
		grid-template-columns: 1fr 12vh 15vh 8vh 6vh 6vh 10vh 10vh;
		gap: 1vh;
		padding: 1.5vh 2vh;
		align-items: center;
		background-color: var(--default-background);
		cursor: pointer;
		transition: background-color 0.15s ease;
	}

	.item:hover {
		background-color: var(--disabled-background);
	}

	.item.selected {
		background-color: var(--primary-background);
	}

	.item .name {
		font-size: 1.8vh;
		font-weight: bold;
		color: var(--default-foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.item.selected .name {
		color: var(--primary-foreground);
	}

	.item .hash {
		font-size: 1.4vh;
		font-family: monospace;
		color: var(--disabled-foreground);
	}

	.item.selected .hash {
		color: var(--primary-foreground);
		opacity: 0.8;
	}

	.item .size {
		font-size: 1.5vh;
		color: var(--default-foreground);
		text-align: right;
	}

	.item.selected .size {
		color: var(--primary-foreground);
	}

	.item .peers {
		font-size: 1.5vh;
		text-align: center;
	}

	.item .peers.download {
		color: var(--secondary-foreground);
	}

	.item .peers.upload {
		color: var(--primary-foreground);
	}

	.item.selected .peers {
		color: var(--primary-foreground);
	}

	.item .speed {
		font-size: 1.4vh;
		text-align: right;
	}

	.item .speed.download {
		color: var(--secondary-foreground);
	}

	.item .speed.upload {
		color: var(--primary-foreground);
	}

	.item.selected .speed {
		color: var(--primary-foreground);
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

<div class="item-wrapper">
	<div class="item" class:selected={selected && selectedFileIndex === -1}>
		<div class="name">
			<span class="expand" class:expanded>▶</span>
			{name}
		</div>
		<div class="hash">{truncateHash(hash)}</div>
		<ProgressBar {progress} completed={isCompleted} height="1.8vh" />
		<div class="size">{size}</div>
		<div class="peers download">↓{downloadPeers}</div>
		<div class="peers upload">↑{uploadPeers}</div>
		<div class="speed download">↓{downloadSpeed}</div>
		<div class="speed upload">↑{uploadSpeed}</div>
	</div>

	{#if expanded}
		<div class="files-wrapper">
			{#each files as file, index (file.id)}
				<DownloadFile name={file.name} progress={file.progress} size={file.size} status={file.status} selected={selected && selectedFileIndex === index} />
			{/each}
		</div>
	{/if}
</div>
