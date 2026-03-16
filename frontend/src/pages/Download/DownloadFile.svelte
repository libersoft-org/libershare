<script lang="ts">
	import type { NavPos } from '../../scripts/navArea.svelte.ts';
	import type { DownloadFileType } from '../../scripts/downloads.ts';
	import Icon from '../../components/Icon/Icon.svelte';
	import ProgressBar from '../../components/ProgressBar/ProgressBar.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	interface Props {
		name: string;
		type?: DownloadFileType | undefined;
		progress: number;
		size: string;
		downloadedSize?: string | undefined;
		selected?: boolean | undefined;
		odd?: boolean | undefined;
		animated?: boolean | undefined;
		el?: HTMLElement | undefined;
		position?: NavPos | undefined;
	}
	let { name, type = 'file', progress, size, downloadedSize, selected = false, odd = false, animated = false, el = $bindable(), position }: Props = $props();
	// Show "downloaded / total" format when downloading (progress < 100 and downloadedSize is provided)
	let sizeDisplay = $derived(downloadedSize ? `${downloadedSize} / ${size}` : size);
	let isFile = $derived(type === 'file');
	let typeIcon = $derived(type === 'directory' ? '/img/directory.svg' : type === 'link' ? '/img/link.svg' : '/img/file.svg');
	let iconColor = $derived(selected ? '--secondary-background' : '--secondary-foreground');
</script>

<style>
	.name {
		font-size: 1.6vh;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		display: flex;
		align-items: center;
		gap: 0.5vh;
	}
</style>

<TableRow {selected} {odd} {position} bind:el>
	<TableCell><span class="name"><Icon img={typeIcon} size="1.6vh" padding="0" colorVariable={iconColor} />{name}</span></TableCell>
	<TableCell align="center">{sizeDisplay}</TableCell>
	<TableCell align="center">
		{#if isFile}
			<ProgressBar {progress} {animated} />
		{:else}
			<div>-</div>
		{/if}
	</TableCell>
</TableRow>
