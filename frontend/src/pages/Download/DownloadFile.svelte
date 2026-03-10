<script lang="ts">
	import type { NavPos } from '../../scripts/navArea.svelte.ts';
	import ProgressBar from '../../components/ProgressBar/ProgressBar.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	interface Props {
		name: string;
		progress: number;
		size: string;
		downloadedSize?: string | undefined;
		selected?: boolean | undefined;
		odd?: boolean | undefined;
		animated?: boolean | undefined;
		el?: HTMLElement | undefined;
		position?: NavPos | undefined;
	}
	let { name, progress, size, downloadedSize, selected = false, odd = false, animated = false, el = $bindable(), position }: Props = $props();
	// Show "downloaded / total" format when downloading (progress < 100 and downloadedSize is provided)
	let sizeDisplay = $derived(downloadedSize && progress < 100 ? `${downloadedSize} / ${size}` : size);
</script>

<style>
	.name {
		font-size: 1.6vh;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>

<TableRow {selected} {odd} {position} bind:el>
	<TableCell><span class="name">{name}</span></TableCell>
	<TableCell align="center">{sizeDisplay}</TableCell>
	<TableCell><ProgressBar {progress} {animated} /></TableCell>
</TableRow>
