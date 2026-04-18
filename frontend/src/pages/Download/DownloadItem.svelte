<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { type DownloadStatus, type EnabledMode } from '../../scripts/downloads.ts';
	import AllowedBadge from '../../components/Badge/AllowedBadge.svelte';
	import { truncateID, formatSize } from '../../scripts/utils.ts';
	import { type NavAreaController, type NavPos, navItem } from '../../scripts/navArea.svelte.ts';
	import ProgressBar from '../../components/ProgressBar/ProgressBar.svelte';
	import Badge from '../../components/Badge/Badge.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	import Icon from '../../components/Icon/Icon.svelte';
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
		totalUploadedBytes?: number;
		totalDownloadedBytes?: number;
		position?: NavPos | undefined;
		onConfirm?: (() => void) | undefined;
		selected?: boolean | undefined;
		isLast?: boolean | undefined;
	}
	let { name, id, progress, size, downloadedSize, status, enabledMode = 'disabled', downloadPeers, uploadPeers, downloadSpeed, uploadSpeed, totalUploadedBytes = 0, totalDownloadedBytes = 0, position, onConfirm, selected = false }: Props = $props();
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

	.peers .dl,
	.peers .ul,
	.transferred .dl,
	.transferred .ul {
		display: inline-flex;
		align-items: center;
		gap: 0.3vh;
	}

	.peers .dl {
		color: var(--mode-download-fg);
	}

	.peers .ul {
		color: var(--mode-upload-fg);
	}

	.transferred {
		display: flex;
		flex-direction: column;
		line-height: 1.2;
	}

	.transferred .dl {
		color: var(--mode-download-fg);
	}

	.transferred .ul {
		color: var(--mode-upload-fg);
	}
</style>

<TableRow bind:el={rowEl} selected={isSelected}>
	<TableCell>
		<div class="name">{name}</div>
	</TableCell>
	<TableCell align="center" desktopOnly>{truncateID(id)}</TableCell>
	<TableCell align="center" desktopOnly>{sizeDisplay}</TableCell>
	<TableCell desktopOnly><ProgressBar {progress} animated={status === 'downloading' || status === 'downloading-uploading' || status === 'verifying' || status === 'moving' || status === 'allocating'} /></TableCell>
	<TableCell align="center" desktopOnly><Badge label={$t('downloads.statuses.' + status)} {status} /></TableCell>
	<TableCell align="center" desktopOnly>
		<span class="transferred">
			{#if totalDownloadedBytes || totalUploadedBytes}
				<div class="dl">
					<Icon img="/img/arrow-down.svg" size="1.4vh" padding="0" colorVariable="--mode-download-fg" />
					<span>{formatSize(totalDownloadedBytes)}</span>
				</div>
				<div class="ul"><Icon img="/img/arrow-up.svg" size="1.4vh" padding="0" colorVariable="--mode-upload-fg" /><span>{formatSize(totalUploadedBytes)}</span></div>
			{:else}
				<div>—</div>
			{/if}
		</span>
	</TableCell>
	<TableCell align="center" desktopOnly>
		<AllowedBadge mode={enabledMode} />
	</TableCell>
	<TableCell align="center" desktopOnly>
		<span class="peers">
			{#if downloadPeers || uploadPeers}
				<div class="dl"><Icon img="/img/arrow-down.svg" size="1.4vh" padding="0" colorVariable="--mode-download-fg" />{downloadPeers}</div>
				<div class="ul"><Icon img="/img/arrow-up.svg" size="1.4vh" padding="0" colorVariable="--mode-upload-fg" />{uploadPeers}</div>
			{:else}
				<div>—</div>
			{/if}
		</span>
	</TableCell>
	<TableCell align="center" desktopOnly>
		<span class="peers">
			{#if downloadSpeed !== '0 B/s' || uploadSpeed !== '0 B/s'}
				<div class="dl"><Icon img="/img/arrow-down.svg" size="1.4vh" padding="0" colorVariable="--mode-download-fg" />{downloadSpeed}</div>
				<div class="ul"><Icon img="/img/arrow-up.svg" size="1.4vh" padding="0" colorVariable="--mode-upload-fg" />{uploadSpeed}</div>
			{:else}
				<div>—</div>
			{/if}
		</span>
	</TableCell>
</TableRow>
