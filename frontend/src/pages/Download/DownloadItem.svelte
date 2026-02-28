<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type DownloadStatus } from '../../scripts/downloads.ts';
	import { truncateID } from '../../scripts/utils.ts';
	import ProgressBar from '../../components/ProgressBar/ProgressBar.svelte';
	import Badge from '../../components/Badge/Badge.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	interface Props {
		name: string;
		id: string;
		progress: number;
		size: string;
		downloadedSize?: string;
		status: DownloadStatus;
		downloadPeers: number;
		uploadPeers: number;
		downloadSpeed: string;
		uploadSpeed: string;
		selected?: boolean;
		isLast?: boolean;
		odd?: boolean;
	}
	let { name, id, progress, size, downloadedSize, status, downloadPeers, uploadPeers, downloadSpeed, uploadSpeed, selected = false, odd = false }: Props = $props();
	// Show "downloaded / total" format when downloading
	let sizeDisplay = $derived(downloadedSize && progress < 100 ? `${downloadedSize} / ${size}` : size);
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

<TableRow {selected} {odd}>
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
