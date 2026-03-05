<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { type DownloadStatus } from '../../scripts/downloads.ts';
	import { truncateID } from '../../scripts/utils.ts';
	import { type NavAreaController, type NavPos, navItem } from '../../scripts/navArea.svelte.ts';
	import ProgressBar from '../../components/ProgressBar/ProgressBar.svelte';
	import Badge from '../../components/Badge/Badge.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	interface Props {
		name: string;
		id: string;
		progress: number;
		size: string;
		downloadedSize?: string | undefined;
		status: DownloadStatus;
		downloadPeers: number;
		uploadPeers: number;
		downloadSpeed: string;
		uploadSpeed: string;
		position?: NavPos | undefined;
		onConfirm?: (() => void) | undefined;
		selected?: boolean | undefined;
		isLast?: boolean | undefined;
		odd?: boolean | undefined;
	}
	let { name, id, progress, size, downloadedSize, status, downloadPeers, uploadPeers, downloadSpeed, uploadSpeed, position, onConfirm, selected = false, odd = false }: Props = $props();
	const navArea = getContext<NavAreaController | undefined>('navArea');
	let rowEl = $state<HTMLElement | undefined>(undefined);
	let isSelected = $derived(navArea && position ? navArea.isSelected(position) : selected);
	// Show "downloaded / total" format when downloading
	let sizeDisplay = $derived(downloadedSize && progress < 100 ? `${downloadedSize} / ${size}` : size);

	onMount(() => {
		if (navArea && position)
			return navArea.register(navItem(() => position!, () => rowEl, onConfirm));
		return undefined;
	});
</script>

<style>
	.name {
		font-size: 2vh;
		font-weight: bold;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>

<TableRow bind:el={rowEl} selected={isSelected} {odd}>
	<TableCell>
		<div class="name">{name}</div>
	</TableCell>
	<TableCell align="center" desktopOnly>{truncateID(id)}</TableCell>
	<TableCell align="center" desktopOnly>{sizeDisplay}</TableCell>
	<TableCell desktopOnly><ProgressBar {progress} animated={status === 'downloading'} /></TableCell>
	<TableCell align="center" desktopOnly><Badge label={$t('downloads.statuses.' + status)} /></TableCell>
	<TableCell align="center" desktopOnly>{downloadPeers}</TableCell>
	<TableCell align="center" desktopOnly>{uploadPeers}</TableCell>
	<TableCell align="center" desktopOnly>{downloadSpeed}</TableCell>
	<TableCell align="center" desktopOnly>{uploadSpeed}</TableCell>
</TableRow>
