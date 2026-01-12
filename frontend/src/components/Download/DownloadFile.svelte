<script lang="ts">
	import ProgressBar from '../ProgressBar/ProgressBar.svelte';
	import TableRow from '../Table/TableRow.svelte';
	import TableCell from '../Table/TableCell.svelte';
	interface Props {
		name: string;
		progress: number;
		size: string;
		selected?: boolean;
		odd?: boolean;
	}
	let { name, progress, size, selected = false, odd = false }: Props = $props();
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
	<TableCell align="center">{size}</TableCell>
	<TableCell><ProgressBar {progress} /></TableCell>
</TableRow>
