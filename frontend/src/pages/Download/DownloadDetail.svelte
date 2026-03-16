<script lang="ts">
	import { onMount } from 'svelte';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { t } from '../../scripts/language.ts';
	import { downloads, resetVerifyState, setCurrentDetailLISHID, DOWNLOAD_TOOLBAR_ACTIONS, handleDownloadToolbarAction, type DownloadToolbarActionID } from '../../scripts/downloads.ts';
	import { scrollToElement } from '../../scripts/utils.ts';
	import { api } from '../../scripts/api.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import Button from '../../components/Buttons/Button.svelte';
	import Table from '../../components/Table/Table.svelte';
	import Header from '../../components/Table/TableHeader.svelte';
	import Cell from '../../components/Table/TableCell.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import ProgressBar from '../../components/ProgressBar/ProgressBar.svelte';
	import Badge from '../../components/Badge/Badge.svelte';
	import DownloadFile from './DownloadFile.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import DownloadDetailDelete from './DownloadDetailDelete.svelte';
	import DownloadLISHExport from './DownloadLISHExport.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		lishID: string;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, lishID, onBack }: Props = $props();
	// Get download from store by lishID
	let download = $derived($downloads.find(d => d.id === lishID) ?? null);
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
	// Toolbar actions - use config from downloads.ts
	let downloadPaused = $state(true);
	let uploadPaused = $state(true);
	let isVerifying = $derived(download?.status === 'verifying' || download?.status === 'pending-verification');
	let toolbarActions = $derived(
		DOWNLOAD_TOOLBAR_ACTIONS.filter(action => (action.id === 'verify' && !isVerifying) || (action.id === 'stop-verify' && isVerifying) || (action.id !== 'verify' && action.id !== 'stop-verify')).map(action => ({
			id: action.id,
			label: action.getLabel($t, downloadPaused, uploadPaused),
			icon: typeof action.icon === 'function' ? action.icon(downloadPaused, uploadPaused) : action.icon,
		}))
	);
	// Delete dialog state
	let showDeleteDialog = $state(false);
	let deleteError = $state('');
	// Export state
	let showExport = $state(false);
	// File browser state
	let showFileBrowser = $state(false);
	let removeFileBrowserBackHandler: (() => void) | null = null;

	let unregisterToolbar: (() => void) | null = null;
	let unregisterInfo: (() => void) | null = null;
	let unregisterList: (() => void) | null = null;

	function registerDetailAreas(): void {
		unregisterToolbar = useArea(toolbarAreaID, toolbarHandlers, position);
		unregisterInfo = useArea(infoAreaID, infoHandlers, position);
		unregisterList = useArea(listAreaID, listHandlers, position);
		activateArea(toolbarAreaID);
	}

	function unregisterDetailAreas(): void {
		unregisterToolbar?.();
		unregisterInfo?.();
		unregisterList?.();
		unregisterToolbar = null;
		unregisterInfo = null;
		unregisterList = null;
	}

	function handleExportBack(): void {
		showExport = false;
		registerDetailAreas();
	}

	function handleFileBrowserBack(): void {
		removeFileBrowserBackHandler?.();
		removeFileBrowserBackHandler = null;
		popBreadcrumb();
		showFileBrowser = false;
		registerDetailAreas();
	}
	function scrollToSelected(): void {
		scrollToElement(itemElements, selectedFileIndex);
	}

	function scrollToInfo(): void {
		if (infoElement) infoElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	function handleBack(): void {
		onBack?.();
	}

	function handleToolbarAction(actionId: DownloadToolbarActionID): void {
		if (actionId === 'toggle-download') {
			downloadPaused = !downloadPaused;
			return;
		}
		if (actionId === 'toggle-upload') {
			uploadPaused = !uploadPaused;
			return;
		}
		if (actionId === 'stop-verify' && download) {
			api.lishs.stopVerify(download.id).catch(err => console.error('Stop verification failed:', err));
			return;
		}
		if (actionId === 'open-directory' && download?.directory) {
			pushBreadcrumb($t('downloads.targetDirectory'));
			unregisterDetailAreas();
			showFileBrowser = true;
			removeFileBrowserBackHandler = pushBackHandler(handleFileBrowserBack);
			return;
		}
		const result = handleDownloadToolbarAction(actionId);
		if (result.needsBack) handleBack();
		if (result.needsDelete) showDeleteDialog = true;
		if (result.needsExport) {
			unregisterDetailAreas();
			showExport = true;
		}
		if (result.needsVerify && download) {
			resetVerifyState(download.id);
			api.lishs.verify(download.id).catch(err => console.error('Verification failed:', err));
		}
	}

	function handleDeleteCancel(): void {
		showDeleteDialog = false;
		activateArea(toolbarAreaID);
	}

	function handleDeleteResult(deleteLISH: boolean, success: boolean): void {
		showDeleteDialog = false;
		if (success && deleteLISH) {
			handleBack();
			return;
		}
		if (!success) deleteError = $t('downloads.deleteFailed');
		activateArea(toolbarAreaID);
	}

	const toolbarHandlers = {
		up() {
			return false;
		},
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
		back() {
			handleBack();
		},
	};

	const infoHandlers = {
		up() {
			activateArea(toolbarAreaID);
			return true;
		},
		down() {
			if (download && download.files.length > 0) {
				activateArea(listAreaID);
				scrollToSelected();
				return true;
			}
			return false;
		},
		left() {
			return false;
		},
		right() {
			return false;
		},
		confirmDown() {},
		confirmUp() {},
		confirmCancel() {},
		back() {
			handleBack();
		},
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
		left() {
			return false;
		},
		right() {
			return false;
		},
		confirmDown() {},
		confirmUp() {
			// TODO: Open file or show file actions
		},
		confirmCancel() {},
		back() {
			handleBack();
		},
	};

	onMount(() => {
		setCurrentDetailLISHID(lishID);
		registerDetailAreas();
		return () => {
			setCurrentDetailLISHID(null);
			unregisterDetailAreas();
			removeFileBrowserBackHandler?.();
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

{#if showFileBrowser && download?.directory}
	<FileBrowser {areaID} {position} initialPath={download.directory} onBack={handleFileBrowserBack} />
{:else if showExport && download}
	<DownloadLISHExport {areaID} {position} lish={{ id: download.id, name: download.name }} onBack={handleExportBack} />
{:else}
	<div class="detail">
		<div class="toolbar">
			{#each toolbarActions as action, index (action.id)}
				<Button icon={action.icon} label={action.label} selected={toolbarActive && selectedToolbarIndex === index} onConfirm={() => handleToolbarAction(action.id)} />
			{/each}
		</div>
		{#if deleteError}
			<Alert type="error" message={deleteError} />
		{/if}
		{#if download}
			<div class="content">
				<div class="info" class:selected={infoActive} bind:this={infoElement}>
					<Table columns="auto 1fr" columnsMobile="auto 1fr" noBorder>
						<TableRow odd>
							<Cell>{$t('common.name')}:</Cell>
							<Cell align="right">{download.name}</Cell>
						</TableRow>
						<TableRow>
							<Cell>{$t('downloads.id')}:</Cell>
							<Cell align="right">{download.id}</Cell>
						</TableRow>
						<TableRow odd>
							<Cell>{$t('downloads.targetDirectory')}:</Cell>
							<Cell align="right">{download.directory ?? '-'}</Cell>
						</TableRow>
						<TableRow>
							<Cell>{$t('common.size')}:</Cell>
							<Cell align="right">{download.downloadedSize ? `${download.downloadedSize} / ${download.size}` : download.size}</Cell>
						</TableRow>
						<TableRow odd>
							<Cell>{$t('common.progress')}:</Cell>
							<Cell align="right"><span class="progress-value"><ProgressBar progress={download.progress} animated={download.status === 'downloading'} /></span></Cell>
						</TableRow>
						<TableRow>
							<Cell>{$t('common.status')}:</Cell>
							<Cell align="right"><Badge label={$t('downloads.statuses.' + download.status)} status={download.status} /></Cell>
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
				<div class="container">
					<Table columns="1fr 15vh 20vh" columnsMobile="1fr 13vh 10vh" noBorder>
						<Header fontSize="1.4vh">
							<Cell>{$t('common.name')}</Cell>
							<Cell align="center">{$t('common.size')}</Cell>
							<Cell align="center">{$t('common.progress')}</Cell>
						</Header>
						<div class="items">
							{#each download.files as file, index (file.id)}
								<DownloadFile bind:el={itemElements[index]} name={file.name} type={file.type} progress={file.progress} size={file.size} downloadedSize={file.downloadedSize} selected={listActive && selectedFileIndex === index} odd={index % 2 === 0} animated={download.status === 'downloading' && file.progress < 100} />
							{/each}
						</div>
					</Table>
				</div>
			</div>
		{/if}
	</div>
	{#if showDeleteDialog && download}
		<DownloadDetailDelete lishID={download.id} lishName={download.name} {position} onResult={handleDeleteResult} onBack={handleDeleteCancel} />
	{/if}
{/if}
