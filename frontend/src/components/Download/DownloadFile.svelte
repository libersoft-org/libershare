<script lang="ts">
	import ProgressBar from '../ProgressBar/ProgressBar.svelte';
	import TableRow from '../Table/TableRow.svelte';
	import TableCell from '../Table/TableCell.svelte';
	interface Props {
		name: string;
		progress: number;
		size: string;
		downloadedSize?: string;
		selected?: boolean;
		odd?: boolean;
		animated?: boolean;
	}
	let { name, progress, size, downloadedSize, selected = false, odd = false, animated = false }: Props = $props();
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

<TableRow {selected} {odd}>
	<TableCell><span class="name">{name}</span></TableCell>
	<TableCell align="center">{sizeDisplay}</TableCell>
	<TableCell><ProgressBar {progress} {animated} /></TableCell>
</TableRow>
