<script lang="ts">
	import ProgressBar from '../ProgressBar/ProgressBar.svelte';
	import Badge from '../Badge/Badge.svelte';
	import TableRow from '../Table/TableRow.svelte';
	import TableCell from '../Table/TableCell.svelte';
	import { t } from '../../scripts/language.ts';
	import type { DownloadStatus } from '../../scripts/downloads.ts';
	import { truncateID } from '../../scripts/utils.ts';

	interface Props {
		name: string;
		id: string;
		progress: number;
		size: string;
		status: DownloadStatus;
		downloadPeers: number;
		uploadPeers: number;
		downloadSpeed: string;
		uploadSpeed: string;
		selected?: boolean;
		isLast?: boolean;
		odd?: boolean;
	}
	let { name, id, progress, size, status, downloadPeers, uploadPeers, downloadSpeed, uploadSpeed, selected = false, isLast = false, odd = false }: Props = $props();
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
	<TableCell align="right" desktopOnly>{size}</TableCell>
	<TableCell desktopOnly><ProgressBar {progress} animated={status === 'downloading'} /></TableCell>
	<TableCell align="center" desktopOnly><Badge label={$t.downloads?.statuses?.[status]} /></TableCell>
	<TableCell align="center" desktopOnly>{downloadPeers}</TableCell>
	<TableCell align="center" desktopOnly>{uploadPeers}</TableCell>
	<TableCell align="center" desktopOnly>{downloadSpeed}</TableCell>
	<TableCell align="center" desktopOnly>{uploadSpeed}</TableCell>
</TableRow>
