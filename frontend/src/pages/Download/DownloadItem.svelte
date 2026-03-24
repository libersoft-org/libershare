<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { type DownloadStatus, type EnabledMode } from '../../scripts/downloads.ts';
	import ModeBadge from '../../components/Badge/ModeBadge.svelte';
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
		enabledMode?: EnabledMode | undefined;
		downloadPeers: number;
		uploadPeers: number;
		downloadSpeed: string;
		uploadSpeed: string;
		position?: NavPos | undefined;
		onConfirm?: (() => void) | undefined;
		selected?: boolean | undefined;
		isLast?: boolean | undefined;
	}
	let { name, id, progress, size, downloadedSize, status, enabledMode = 'disabled', downloadPeers, uploadPeers, downloadSpeed, uploadSpeed, position, onConfirm, selected = false }: Props = $props();
	const navArea = getContext<NavAreaController | undefined>('navArea');
	let rowEl = $state<HTMLElement | undefined>(undefined);
	let isSelected = $derived(navArea && position ? navArea.isSelected(position) : selected);
	// Show "downloaded / total" format when downloading
	let sizeDisplay = $derived(downloadedSize && progress < 100 ? `${downloadedSize} / ${size}` : size);

	onMount(() => {
		if (navArea && position)
			return navArea.register(
				navItem(
					() => position!,
					() => rowEl,
					onConfirm
				)
			);
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

	.peers .dl {
		color: var(--mode-download-fg);
	}

	.peers .ul {
		color: var(--mode-upload-fg);
	}
</style>

<TableRow bind:el={rowEl} selected={isSelected}>
	<TableCell>
		<div class="name">{name}</div>
	</TableCell>
	<TableCell align="center" desktopOnly>{truncateID(id)}</TableCell>
	<TableCell align="center" desktopOnly>{sizeDisplay}</TableCell>
	<TableCell desktopOnly><ProgressBar {progress} animated={status === 'downloading' || status === 'downloading-uploading' || status === 'verifying' || status === 'moving'} /></TableCell>
	<TableCell align="center" desktopOnly><Badge label={$t('downloads.statuses.' + status)} {status} /></TableCell>
	<TableCell align="center" desktopOnly><ModeBadge mode={enabledMode} /></TableCell>
	<TableCell align="center" desktopOnly><span class="peers">{#if downloadPeers || uploadPeers}<span class="dl">↓{downloadPeers}</span> <span class="ul">↑{uploadPeers}</span>{:else}—{/if}</span></TableCell>
	<TableCell align="center" desktopOnly><span class="peers">{#if downloadSpeed !== '0 B/s' || uploadSpeed !== '0 B/s'}<span class="dl">↓{downloadSpeed}</span> <span class="ul">↑{uploadSpeed}</span>{:else}—{/if}</span></TableCell>
</TableRow>
