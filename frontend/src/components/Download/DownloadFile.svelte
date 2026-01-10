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
		grid-template-columns: 1fr 10vh 20vh;
		align-items: center;
		gap: 2vh;
		padding: 0.5vh 2vh;
		border-bottom: 0.4vh solid var(--secondary-background);
		color: var(--secondary-foreground);
	}

	.file.selected {
		background-color: var(--primary-foreground);
		color: var(--primary-background);
	}

	.file .name {
		font-size: 1.6vh;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.center {
		text-align: center;
	}

	@media (max-width: 1199px) {
		.file {
			grid-template-columns: 1fr 5vh 10vh;
		}

		.file .name {
			font-size: 1.4vh;
		}
	}
</style>

<div class="file" class:selected>
	<div class="name">{name}</div>
	<div class="size center">{size}</div>
	<ProgressBar {progress} />
</div>
