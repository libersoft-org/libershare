<script lang="ts">
	import ProgressBar from '../ProgressBar/ProgressBar.svelte';
	interface Props {
		name: string;
		progress: number;
		size: string;
		selected?: boolean;
	}
	let { name, progress, size, selected = false }: Props = $props();
</script>

<style>
	.file {
		display: grid;
		grid-template-columns: 1fr 15vh 10vh;
		gap: 1vh;
		padding: 1vh 2vh;
		align-items: center;
		background-color: var(--default-background);
		border-bottom: 1px solid var(--disabled-background);
	}

	.file.selected {
		background-color: var(--primary-background);
	}

	.file .name {
		font-size: 1.6vh;
		color: var(--default-foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file.selected .name {
		color: var(--primary-foreground);
	}

	.file .size {
		font-size: 1.4vh;
		color: var(--disabled-foreground);
		text-align: right;
	}

	.file.selected .size {
		color: var(--primary-foreground);
	}
</style>

<div class="file" class:selected>
	<div class="name">{name}</div>
	<ProgressBar {progress} />
	<div class="size">{size}</div>
</div>
