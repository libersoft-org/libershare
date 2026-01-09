<script lang="ts">
	import ProgressBar from '../ProgressBar/ProgressBar.svelte';

	interface Props {
		name: string;
		progress: number;
		size: string;
		status: 'completed' | 'downloading' | 'waiting' | 'paused' | 'error';
		selected?: boolean;
	}
	let { name, progress, size, status, selected = false }: Props = $props();

	const statusLabels: Record<string, string> = {
		completed: 'Dokončeno',
		downloading: 'Stahování',
		waiting: 'Čeká',
		paused: 'Pozastaveno',
		error: 'Chyba',
	};
</script>

<style>
	.file-row {
		display: grid;
		grid-template-columns: 1fr 15vh 10vh 10vh;
		gap: 1vh;
		padding: 1vh 2vh;
		align-items: center;
		background-color: var(--default-background);
		border-bottom: 1px solid var(--disabled-background);
	}

	.file-row.selected {
		background-color: var(--primary-background);
	}

	.file-name {
		font-size: 1.6vh;
		color: var(--default-foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-row.selected .file-name {
		color: var(--primary-foreground);
	}

	.file-size {
		font-size: 1.4vh;
		color: var(--disabled-foreground);
		text-align: right;
	}

	.file-row.selected .file-size {
		color: var(--primary-foreground);
	}

	.file-status {
		font-size: 1.4vh;
		text-align: center;
		padding: 0.3vh 0.6vh;
		border-radius: 0.5vh;
	}

	.file-status.completed {
		background-color: var(--secondary-background);
		color: var(--secondary-foreground);
	}

	.file-status.downloading {
		background-color: var(--primary-background);
		color: var(--primary-foreground);
	}

	.file-status.waiting {
		background-color: var(--disabled-background);
		color: var(--disabled-foreground);
	}

	.file-status.paused {
		background-color: var(--disabled-background);
		color: var(--disabled-foreground);
	}

	.file-status.error {
		background-color: #c0392b;
		color: white;
	}
</style>

<div class="file-row" class:selected>
	<div class="file-name">{name}</div>
	<ProgressBar {progress} completed={status === 'completed'} height="1.5vh" />
	<div class="file-size">{size}</div>
	<div class="file-status {status}">{statusLabels[status]}</div>
</div>
