<script lang="ts">
	import { onMount } from 'svelte';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { t } from '../../scripts/language.ts';
	import { selectedDownload, DOWNLOAD_TOOLBAR_ACTIONS, handleDownloadToolbarAction, type DownloadData, type DownloadToolbarActionId } from '../../scripts/downloads.ts';
	import { scrollToElement, truncateID } from '../../scripts/utils.ts';
	import Button from '../../components/Buttons/Button.svelte';
	import Table from '../../components/Table/Table.svelte';
	import Header from '../../components/Table/TableHeader.svelte';
	import Cell from '../../components/Table/TableCell.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import ProgressBar from '../../components/ProgressBar/ProgressBar.svelte';
	import Badge from '../../components/Badge/Badge.svelte';
	import DownloadFile from './DownloadFile.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	// Get download from store
	let download = $state<DownloadData | null>(null);
	const unsubscribe = selectedDownload.subscribe(d => (download = d));
	// Toolbar state
	let toolbarAreaID = $derived(`${areaID}-toolbar`);
	let infoAreaID = $derived(`${areaID}-info`);
	let listAreaID = $derived(`${areaID}-list`);
	let toolbarActive = $derived($activeArea === toolbarAreaID);
	let infoActive = $derived($activeArea === infoAreaID);
	let listActive = $derived($activeArea === listAreaID);
	let selectedToolbarIndex = $state(0);
	let selectedFileIndex = $state(0);
	let itemElements: HTMLElement[] = $state([]);
	let infoElement: HTMLElement | null = $state(null);
	let filesElement: HTMLElement | null = $state(null);
	// Toolbar actions - use config from downloads.ts
	let isPaused = $derived(download?.status === 'paused');
	let toolbarActions = $derived(
		DOWNLOAD_TOOLBAR_ACTIONS.map(action => ({
			id: action.id,
			label: action.getLabel($t, isPaused),
			icon: action.getIcon?.(isPaused) ?? action.icon,
		}))
	);
	function scrollToSelected(): void {
		scrollToElement(itemElements, selectedFileIndex);
	}

	function handleFileClick(index: number) {
		activateArea(listAreaID);
		selectedFileIndex = index;
		scrollToSelected();
	}

	function scrollToInfo(): void {
		if (infoElement) infoElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	function scrollToFiles(): void {
		if (filesElement) filesElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	function handleToolbarAction(actionId: DownloadToolbarActionId): void {
		const result = handleDownloadToolbarAction(actionId, download);
		if (result.needsBack) onBack?.();
	}

	const toolbarHandlers = {
		up() { return false; },
		down() {
			if (download) {
				activateArea(infoAreaID);
				scrollToInfo();
				return true;
			}
			return false;
		},
		left() {
			if (selectedToolbarIndex > 0) {
				selectedToolbarIndex--;
				return true;
			}
			return false;
		},
		right() {
			if (selectedToolbarIndex < toolbarActions.length - 1) {
				selectedToolbarIndex++;
				return true;
			}
			return false;
		},
		confirmDown() {},
		confirmUp() {
			const action = toolbarActions[selectedToolbarIndex];
			if (action) handleToolbarAction(action.id);
		},
		confirmCancel() {},
		back() { onBack?.(); },
	};

	const infoHandlers = {
		up() {
			activateArea(toolbarAreaID);
			return true;
		},
		down() {
			if (download && download.files.length > 0) {
				activateArea(listAreaID);
				scrollToFiles();
				return true;
			}
			return false;
		},
		left() { return false; },
		right() { return false; },
		confirmDown() {},
		confirmUp() {},
		confirmCancel() {},
		back() { onBack?.(); },
	};

	const listHandlers = {
		up() {
			if (selectedFileIndex > 0) {
				selectedFileIndex--;
				scrollToSelected();
				return true;
			}
			activateArea(infoAreaID);
			scrollToInfo();
			return true;
		},
		down() {
			if (download && selectedFileIndex < download.files.length - 1) {
				selectedFileIndex++;
				scrollToSelected();
				return true;
			}
			return false;
		},
		left() { return false; },
		right() { return false; },
		confirmDown() {},
		confirmUp() {
			// TODO: Open file or show file actions
		},
		confirmCancel() {},
		back() { onBack?.(); },
	};

	onMount(() => {
		const unregisterToolbar = useArea(toolbarAreaID, toolbarHandlers, position);
		const unregisterInfo = useArea(infoAreaID, infoHandlers, position);
		const unregisterList = useArea(listAreaID, listHandlers, position);
		activateArea(toolbarAreaID);
		return () => {
			unregisterToolbar();
			unregisterInfo();
			unregisterList();
			unsubscribe();
		};
	});
</script>

<style>
	.detail {
		display: flex;
		flex-direction: column;
		height: 100%;
		gap: 1vh;
	}

	.toolbar {
		display: flex;
		flex-direction: row;
		flex-wrap: wrap;
		gap: 1vh;
		padding: 1vh 2vh;
	}

	.content {
		display: flex;
		flex-direction: row;
		gap: 2vh;
		flex: 1;
		padding: 0 2vh;
		overflow: hidden;
	}

	.info {
		font-size: 1.6vh;
		border: 0.4vh solid var(--secondary-softer-background);
		border-radius: 2vh;
		min-width: 35vh;
		max-width: 50vh;
		overflow: hidden;
	}

	.info.selected {
		border-color: var(--primary-foreground);
	}

	.info .progress-value {
		display: inline-block;
		width: 15vh;
	}

	.container {
		flex: 1;
		border: 0.4vh solid var(--secondary-softer-background);
		border-radius: 2vh;
		overflow: hidden;
	}

	.items {
		flex: 1;
		overflow-y: auto;
		font-size: 1.4vh;
	}

	@media (max-width: 1199px) {
		.content {
			flex-direction: column;
		}

		.info {
			max-width: none;
			min-width: auto;
			flex-shrink: 0;
		}

		.container {
			min-height: 40vh;
			flex-shrink: 0;
		}
	}
</style>

<div class="detail">
	<div class="toolbar">
		{#each toolbarActions as action, index (action.id)}
			<Button icon={action.icon} label={action.label} selected={toolbarActive && selectedToolbarIndex === index} onConfirm={() => handleToolbarAction(action.id)} />
		{/each}
	</div>
	{#if download}
		<div class="content">
			<!-- Info with LISH details -->
			<div class="info" class:selected={infoActive} bind:this={infoElement}>
				<Table columns="auto 1fr" columnsMobile="auto 1fr" noBorder>
					<TableRow odd>
					<Cell>{$t('common.name')}:</Cell>
						<Cell align="right">{download.name}</Cell>
					</TableRow>
					<TableRow>
						<Cell>{$t('downloads.id')}:</Cell>
						<Cell align="right">{truncateID(download.id)}</Cell>
					</TableRow>
					<TableRow odd>
						<Cell>{$t('downloads.targetFolder')}:</Cell>
						<Cell align="right">/share/download/debian/</Cell>
					</TableRow>
					<TableRow>
						<Cell>{$t('common.size')}:</Cell>
						<Cell align="right">{download.downloadedSize && download.progress < 100 ? `${download.downloadedSize} / ${download.size}` : download.size}</Cell>
					</TableRow>
					<TableRow odd>
						<Cell>{$t('common.progress')}:</Cell>
						<Cell align="right"><span class="progress-value"><ProgressBar progress={download.progress} animated={download.status === 'downloading'} /></span></Cell>
					</TableRow>
					<TableRow>
						<Cell>{$t('common.status')}:</Cell>
						<Cell align="right"><Badge label={$t('downloads.statuses.' + download.status)} /></Cell>
					</TableRow>
					<TableRow odd>
						<Cell>{$t('downloads.downloadingFrom')}:</Cell>
						<Cell align="right">{download.downloadPeers}</Cell>
					</TableRow>
					<TableRow>
						<Cell>{$t('downloads.uploadingTo')}:</Cell>
						<Cell align="right">{download.uploadPeers}</Cell>
					</TableRow>
					<TableRow odd>
						<Cell>{$t('downloads.downloadSpeed')}:</Cell>
						<Cell align="right">{download.downloadSpeed}</Cell>
					</TableRow>
					<TableRow>
						<Cell>{$t('downloads.uploadSpeed')}:</Cell>
						<Cell align="right">{download.uploadSpeed}</Cell>
					</TableRow>
				</Table>
			</div>
			<!-- Files table -->
			<div class="container" bind:this={filesElement}>
				<Table columns="1fr 15vh 20vh" columnsMobile="1fr 13vh 10vh" noBorder>
					<Header fontSize="1.4vh">
					<Cell>{$t('common.name')}</Cell>
						<Cell align="center">{$t('common.size')}</Cell>
						<Cell align="center">{$t('common.progress')}</Cell>
					</Header>
					<div class="items">
						{#each download.files as file, index (file.id)}
							<div bind:this={itemElements[index]} onclick={() => handleFileClick(index)} onmouseenter={() => { activateArea(listAreaID); selectedFileIndex = index; }} onkeydown={e => e.key === 'Enter' && handleFileClick(index)} role="row" tabindex="-1">
								<DownloadFile name={file.name} progress={file.progress} size={file.size} downloadedSize={file.downloadedSize} selected={listActive && selectedFileIndex === index} odd={index % 2 === 0} animated={download.status === 'downloading' && file.progress < 100} />
							</div>
						{/each}
					</div>
				</Table>
			</div>
		</div>
	{/if}
</div>
