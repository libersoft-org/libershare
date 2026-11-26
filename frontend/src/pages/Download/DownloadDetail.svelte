<script lang="ts">
	import { onMount } from 'svelte';
	import { activateArea, activeArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { t, translateErrorCode } from '../../scripts/language.ts';
	import { downloads, peerDetails, peerSnapshotReceived, resetVerifyState, setCurrentDetailLISHID, DOWNLOAD_TOOLBAR_ACTIONS, handleDownloadToolbarAction, type DownloadToolbarActionID, type PeerDetail, type DownloadFileData, computeEnabledMode } from '../../scripts/downloads.ts';
	import { copyToClipboard } from '../../scripts/clipboard.ts';
	import AllowedBadge from '../../components/Badge/AllowedBadge.svelte';
	import { formatSize } from '../../scripts/utils.ts';
	import { api } from '../../scripts/api.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { createNavArea, type NavAreaOptions } from '../../scripts/navArea.svelte.ts';
	import NavScope from '../../components/NavArea/NavScope.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Table from '../../components/Table/Table.svelte';
	import Header from '../../components/Table/TableHeader.svelte';
	import Cell from '../../components/Table/TableCell.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import ProgressBar from '../../components/ProgressBar/ProgressBar.svelte';
	import Badge from '../../components/Badge/Badge.svelte';
	import Icon from '../../components/Icon/Icon.svelte';
	import Tabs, { type TabDef } from '../../components/Tabs/Tabs.svelte';
	import DownloadFile from './DownloadFile.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import DownloadDetailDelete from './DownloadDetailDelete.svelte';
	import DownloadDetailPeer from './DownloadDetailPeer.svelte';
	import DownloadLISHExport from './DownloadLISHExport.svelte';
	import DownloadDetailMove from './DownloadDetailMove.svelte';
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
	let tabAreaID = $derived(`${areaID}-tabs`);
	let listAreaID = $derived(`${areaID}-list`);
	let peerListAreaID = $derived(`${areaID}-peerlist`);
	let infoActive = $derived($activeArea === infoAreaID);
	// The info table, the tab row and the two lists are declarative NavAreas of their own (NavScope).
	let infoScope: ReturnType<typeof NavScope> | undefined = $state();
	let tabScope: ReturnType<typeof NavScope> | undefined = $state();
	let fileScope: ReturnType<typeof NavScope> | undefined = $state();
	let peerScope: ReturnType<typeof NavScope> | undefined = $state();
	// Rows the lists come back to after a tab switch or a sub-page, which re-create them.
	let selectedFileIndex = $state(0);
	let selectedPeerIndex = $state(0);
	$effect(() => {
		const filePosition = fileScope?.controller.selectedPosition;
		const peerPosition = peerScope?.controller.selectedPosition;
		if (filePosition) selectedFileIndex = filePosition[1];
		if (peerPosition) selectedPeerIndex = peerPosition[1];
	});
	let activeTab = $state<string>('files');
	let tabDefs = $derived<TabDef[]>([
		{ id: 'files', icon: '/img/file.svg', label: $t('common.files') },
		{ id: 'peers', icon: '/img/share.svg', label: $t('common.connections') },
	]);
	// A click on a tab switches it without moving the selection, so move it here. The list that
	// had the keyboard goes away with the old tab, so the keyboard continues on the tab row.
	function handleTabChange(id: string): void {
		tabScope?.controller.select([id === 'files' ? 0 : 1, 0]);
		activateArea(tabAreaID);
	}
	let containerElement: HTMLElement | null = $state(null);
	type InfoRowKind = 'text' | 'description' | 'progress' | 'status' | 'allowed';
	interface InfoRow {
		label: string;
		kind: InfoRowKind;
		value?: string;
	}
	let infoRows = $derived<InfoRow[]>(download ? [{ label: $t('downloads.id'), kind: 'text' as InfoRowKind, value: download.id }, { label: $t('common.name'), kind: 'text' as InfoRowKind, value: download.name }, ...(download.description ? [{ label: $t('common.description'), kind: 'description' as InfoRowKind, value: download.description }] : []), { label: $t('downloads.targetDirectory'), kind: 'text' as InfoRowKind, value: download.directory ?? '-' }, { label: $t('common.size'), kind: 'text' as InfoRowKind, value: download.downloadedSize ? `${download.downloadedSize} / ${download.size}` : download.size }, { label: $t('downloads.chunks'), kind: 'text' as InfoRowKind, value: `${download.totalChunks} (${formatSize(download.chunkSize)})` }, { label: $t('common.progress'), kind: 'progress' as InfoRowKind }, { label: $t('common.status'), kind: 'status' as InfoRowKind }, { label: $t('downloads.allowed'), kind: 'allowed' as InfoRowKind }, { label: $t('downloads.downloadingFrom'), kind: 'text' as InfoRowKind, value: String(download.downloadPeers) }, { label: $t('downloads.uploadingTo'), kind: 'text' as InfoRowKind, value: String(download.uploadPeers) }, { label: $t('downloads.downloadSpeed'), kind: 'text' as InfoRowKind, value: download.downloadSpeed }, { label: $t('downloads.uploadSpeed'), kind: 'text' as InfoRowKind, value: download.uploadSpeed }, { label: $t('downloads.downloaded'), kind: 'text' as InfoRowKind, value: formatSize(download.totalDownloadedBytes) }, { label: $t('downloads.uploaded'), kind: 'text' as InfoRowKind, value: formatSize(download.totalUploadedBytes) }] : []);
	// Per-peer data for this LISH
	let currentPeers = $derived([...($peerDetails.get(lishID) ?? [])].sort((a, b) => a.peerID.localeCompare(b.peerID)));
	let peerSnapshotLoaded = $derived($peerSnapshotReceived.get(lishID) === true);
	// Toolbar actions - adapt to current download state
	let isVerifying = $derived(download?.status === 'verifying' || download?.status === 'pending-verification');
	let isMoving = $derived(download?.status === 'moving');
	let isAllocating = $derived(download?.status === 'allocating');
	let isBusy = $derived(isVerifying || isMoving || isAllocating);
	// While allocating, file rows show the allocation overlay; real download progress otherwise.
	const fileDisplayProgress = (file: DownloadFileData): number => (isAllocating && file.allocProgress != null ? file.allocProgress : file.progress);
	let isDownloading = $derived(download?.downloadEnabled ?? false);
	let isUploading = $derived(download?.uploadEnabled ?? false);
	let downloadPaused = $derived(!isDownloading);
	let uploadPaused = $derived(!isUploading);
	let enabledMode = $derived(download ? computeEnabledMode(download.downloadEnabled, download.uploadEnabled) : ('disabled' as const));
	let toolbarActions = $derived(
		DOWNLOAD_TOOLBAR_ACTIONS.filter(action => {
			if (action.id === 'toggle-download') return true;
			if (action.id === 'toggle-upload') return true;
			if (action.id === 'move' && isBusy) return false;
			if (action.id === 'verify' && !isVerifying && !isMoving && !isAllocating) return true;
			if (action.id === 'stop-verify' && isVerifying) return true;
			if (action.id === 'verify' || action.id === 'stop-verify') return false;
			return true;
		}).map(action => ({
			id: action.id,
			label: action.getLabel($t, downloadPaused, uploadPaused),
			icon: typeof action.icon === 'function' ? action.icon(downloadPaused, uploadPaused) : action.icon,
		}))
	);
	// Delete dialog state
	let now = $state(Date.now());
	let showDeleteDialog = $state(false);
	let deleteError = $state('');
	// Peer detail dialog state
	let showPeerDialog = $state(false);
	let selectedPeerID = $state('');
	// Snapshot captured at open time — shown if the peer is pruned from the store while the dialog is open.
	let selectedPeerSnapshot = $state<PeerDetail | null>(null);
	// Export state
	let showExport = $state(false);
	// Move state
	let showMove = $state(false);
	// File browser state
	let showFileBrowser = $state(false);
	let removeFileBrowserBackHandler: (() => void) | null = null;

	// The toolbar is a declarative NavArea: its buttons register themselves by [x, y].
	// The action that opened a sub-page; remembered on confirm, so a mouse click counts too.
	let openedByAction: DownloadToolbarActionID = 'back';
	const toolbarNav = createNavArea(() => ({
		areaID: `${areaID}-toolbar`,
		position,
		onBack: handleBack,
		onDown(): string | false {
			if (!download) return false;
			infoScope?.controller.select([0, 0]);
			return infoAreaID;
		},
	}));

	// The other areas leave the page with the detail when a sub-page opens; only the toolbar pauses.
	function unregisterDetailAreas(): void {
		toolbarNav.pause();
	}

	/** Bring the areas back after a sub-page closes, with the toolbar on the button that opened it. */
	function restoreDetailAreas(): void {
		toolbarNav.resume();
		// By action, not by slot: the sub-page may have changed which buttons the toolbar shows.
		toolbarNav.controller.select([
			Math.max(
				0,
				toolbarActions.findIndex(action => action.id === openedByAction)
			),
			0,
		]);
		activateArea(toolbarAreaID);
	}

	function handleExportBack(): void {
		showExport = false;
		restoreDetailAreas();
	}

	function handleMoveBack(): void {
		popBreadcrumb();
		showMove = false;
		restoreDetailAreas();
	}

	function handleFileBrowserBack(): void {
		removeFileBrowserBackHandler?.();
		removeFileBrowserBackHandler = null;
		popBreadcrumb();
		showFileBrowser = false;
		restoreDetailAreas();
	}
	// Scrolls the files/peers container into view — on mobile it sits below the info table.
	function scrollToContainer(): void {
		if (containerElement) containerElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	// The files/peers panel sits to the RIGHT of the info table on desktop, so
	// left/right arrows switch between the two panels from any row. Enters the
	// active tab's table directly; falls back to the tab bar when it's empty.
	function rightPanelAreaID(): string {
		if (activeTab === 'files' && download && download.files.length > 0) return listAreaID;
		if (activeTab === 'peers' && currentPeers.length > 0) return peerListAreaID;
		return tabAreaID;
	}

	function infoOptions(): NavAreaOptions {
		return {
			areaID: infoAreaID,
			position,
			onBack: handleBack,
			listRange: (): [number, number] => [0, infoRows.length - 1],
			onUp: (): string => toolbarAreaID,
			onDown(): string {
				scrollToContainer();
				return tabAreaID;
			},
			onRight: rightPanelAreaID,
		};
	}

	function tabOptions(): NavAreaOptions {
		return {
			areaID: tabAreaID,
			position,
			onBack: handleBack,
			initialPosition: [activeTab === 'files' ? 0 : 1, 0],
			onUp(): string {
				infoScope?.controller.select([0, infoRows.length - 1]);
				return infoAreaID;
			},
			onDown(): string | false {
				const target = rightPanelAreaID();
				return target === tabAreaID ? false : target;
			},
			onLeft: (): string => infoAreaID,
		};
	}

	function fileListOptions(): NavAreaOptions {
		return {
			areaID: listAreaID,
			position,
			onBack: handleBack,
			initialPosition: [0, selectedFileIndex],
			listRange: (): [number, number] => [0, (download?.files.length ?? 0) - 1],
			onUp: (): string => tabAreaID,
			onLeft: (): string => infoAreaID,
		};
	}

	function peerListOptions(): NavAreaOptions {
		return {
			areaID: peerListAreaID,
			position,
			onBack: handleBack,
			initialPosition: [0, Math.min(selectedPeerIndex, Math.max(0, currentPeers.length - 1))],
			listRange: (): [number, number] => [0, currentPeers.length - 1],
			onUp: (): string => tabAreaID,
			onLeft: (): string => infoAreaID,
		};
	}

	function handleBack(): void {
		onBack?.();
	}

	function confirmToolbarAction(actionID: DownloadToolbarActionID): void {
		openedByAction = actionID;
		handleToolbarAction(actionID);
	}

	function handleToolbarAction(actionID: DownloadToolbarActionID): void {
		if (actionID === 'toggle-download' && download) {
			if (isDownloading) {
				api.call('transfer.disableDownload', { lishID: download.id });
			} else {
				api.call('transfer.enableDownload', { lishID: download.id });
			}
			return;
		}
		if (actionID === 'toggle-upload' && download) {
			if (isUploading) {
				api.call('transfer.disableUpload', { lishID: download.id });
			} else {
				api.call('transfer.enableUpload', { lishID: download.id });
			}
			return;
		}
		if (actionID === 'stop-verify' && download) {
			api.lishs.stopVerify(download.id).catch(err => console.error('Stop verification failed:', err));
			return;
		}
		if (actionID === 'find-peers' && download) {
			api.call('transfer.findPeers', { lishID: download.id }).catch(err => console.error('Find peers failed:', err));
			return;
		}
		if (actionID === 'copy-lish-id' && download) {
			copyToClipboard(download.id, $t('common.lishIDCopied'));
			return;
		}
		if (actionID === 'open-directory' && download?.directory) {
			pushBreadcrumb($t('downloads.targetDirectory'));
			unregisterDetailAreas();
			showFileBrowser = true;
			removeFileBrowserBackHandler = pushBackHandler(handleFileBrowserBack);
			return;
		}
		const result = handleDownloadToolbarAction(actionID);
		if (result.needsBack) handleBack();
		if (result.needsDelete) showDeleteDialog = true;
		if (result.needsExport) {
			unregisterDetailAreas();
			showExport = true;
		}
		if (result.needsMove) {
			pushBreadcrumb($t('downloads.moveData'));
			unregisterDetailAreas();
			showMove = true;
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

	async function handleDeleteResult(deleteLISH: boolean, success: boolean): Promise<void> {
		showDeleteDialog = false;
		if (success && deleteLISH) {
			handleBack();
			return;
		}
		if (!success) deleteError = $t('common.deleteFailed');
		// Backend already handles verification after data-only delete (startVerification in del())
		activateArea(toolbarAreaID);
	}

	function openPeerDialog(peer: PeerDetail): void {
		// Capture the peerID VALUE (not the index): sorting/pruning can reorder currentPeers,
		// so the index is not stable while the dialog is open.
		selectedPeerID = peer.peerID;
		selectedPeerSnapshot = peer;
		showPeerDialog = true;
	}

	function handlePeerDialogBack(): void {
		showPeerDialog = false;
		selectedPeerSnapshot = null;
		activateArea(peerListAreaID);
	}

	onMount(() => {
		// Capture the lishID at mount: the prop is cleared when the LISH is deleted and we
		// navigate back, so reading it lazily in the cleanup would unsubscribe with an empty
		// lishID (backend MISSING_PARAMETER). The captured value always matches the subscribe.
		const subscribedLishID = lishID;
		setCurrentDetailLISHID(subscribedLishID);
		activateArea(toolbarAreaID);
		// Subscribe to per-peer details for this LISH
		if (subscribedLishID) api.call('transfer.subscribePeers', { lishID: subscribedLishID });
		const clockInterval = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => {
			clearInterval(clockInterval);
			setCurrentDetailLISHID(null);
			if (subscribedLishID) api.call('transfer.unsubscribePeers', { lishID: subscribedLishID });
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
		overflow-y: auto;
	}

	.info.selected {
		border-color: var(--primary-foreground);
	}

	/* Round the first/last row background so a selected row follows the panel's rounded corners. */
	.info :global(.row:first-child) {
		border-top-left-radius: 1.6vh;
		border-top-right-radius: 1.6vh;
	}

	.info :global(.row:last-child) {
		border-bottom-left-radius: 1.6vh;
		border-bottom-right-radius: 1.6vh;
	}

	.info .progress-value {
		display: inline-block;
		width: 15vh;
	}

	.info .description {
		white-space: pre-line;
		text-align: left;
		display: inline-block;
	}

	.container {
		flex: 1;
		border: 0.4vh solid var(--secondary-softer-background);
		border-radius: 2vh;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.items {
		flex: 1;
		overflow-y: auto;
		font-size: 1.4vh;
	}

	.empty-peers {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		font-size: 1.6vh;
		color: var(--secondary-foreground);
	}

	.peer-id {
		font-family: var(--font-mono);
		font-size: 1.5vh;
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.conn-badge {
		display: inline-block;
		text-align: center;
		padding: 0.3vh 0.8vh;
		border-radius: 0.5vh;
		font-size: 1.2vh;
		font-weight: bold;
		white-space: nowrap;
	}

	.conn-direct {
		color: var(--mode-download-fg, #0c0);
		background-color: var(--mode-download-bg, #142);
		border: 0.2vh solid var(--mode-download-fg, #0c0);
	}

	.conn-relay {
		color: var(--mode-upload-fg, #28f);
		background-color: var(--mode-upload-bg, #134);
		border: 0.2vh solid var(--mode-upload-fg, #28f);
	}

	.conn-dcutr {
		color: #c8f;
		background-color: #214;
		border: 0.2vh solid #c8f;
	}

	.peer-metric {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.2vh;
		font-family: var(--font-mono);
		font-size: 1.5vh;
		white-space: nowrap;
	}

	.speed-dl,
	.speed-ul,
	.total-dl,
	.total-ul {
		display: inline-flex;
		align-items: center;
		gap: 0.4vh;
	}

	.speed-dl,
	.total-dl {
		color: var(--mode-download-fg, #0c0);
	}

	.speed-ul,
	.total-ul {
		color: var(--mode-upload-fg, #28f);
	}

	.peer-metric.sel .speed-dl,
	.peer-metric.sel .speed-ul,
	.peer-metric.sel .total-dl,
	.peer-metric.sel .total-ul {
		color: inherit;
	}

	.speed-dl,
	.speed-ul {
		font-weight: bold;
	}

	.peer-file {
		font-size: 1.4vh;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.peer-ago {
		font-size: 1.4vh;
		font-family: var(--font-mono);
		color: var(--secondary-foreground);
	}

	:global(.row.selected) .peer-ago,
	:global(.row.selected) .peer-file,
	:global(.row.selected) .peer-id,
	:global(.row.selected) .conn-badge {
		color: var(--primary-background);
	}

	:global(.row.selected) .conn-badge {
		background-color: transparent;
		border-color: var(--primary-background);
	}

	@media (max-width: 1199px) {
		.content {
			flex-direction: column;
			overflow-y: auto;
		}

		.info {
			max-width: none;
			min-width: auto;
			flex-shrink: 0;
			overflow-y: visible;
		}

		.container {
			min-height: 40vh;
			flex-shrink: 0;
		}
	}

	.alert-container {
		padding: 1vh 2vh;
	}
</style>

{#if showFileBrowser && download?.directory}
	<FileBrowser {areaID} {position} initialPath={download.directory} onBack={handleFileBrowserBack} />
{:else if showExport && download}
	<DownloadLISHExport {areaID} {position} lish={{ id: download.id, name: download.name }} onBack={handleExportBack} />
{:else if showMove && download}
	<DownloadDetailMove {areaID} {position} lish={{ id: download.id, name: download.name, directory: download.directory }} onBack={handleMoveBack} />
{:else}
	<div class="detail">
		<div class="toolbar">
			{#each toolbarActions as action, index (index)}
				<Button icon={action.icon} label={action.label} position={[index, 0]} onConfirm={() => confirmToolbarAction(action.id)} padding="1.2vh 1.8vh" fontSize="1.6vh" width="auto" />
			{/each}
		</div>
		{#if deleteError}
			<div class="alert-container"><Alert type="error" message={deleteError} /></div>
		{/if}
		{#if download?.status === 'retrying' && download.retryErrorCode}
			<div class="alert-container"><Alert type="warning" message={`${$t('downloads.statuses.retrying')}: ${download.retryErrorCode}${download.retryCount ? ` (${download.retryCount}/${download.retryMaxRetries ?? '?'})` : ''}`} /></div>
		{/if}
		{#if download?.status === 'error' && (download.errorCode || download.errorMessage)}
			{@const recoveryText = download.recoveryNextAt === 0 ? $t('downloads.recoveryAttempting') : download.recoveryNextAt ? $t('downloads.recoveryScheduled', { seconds: String(Math.max(1, Math.ceil((download.recoveryNextAt - now) / 1000))) }) : ''}
			<div class="alert-container"><Alert type="error" message={`${$t('downloads.statuses.error')}: ${download.errorCode ? translateErrorCode(download.errorCode, download.errorMessage !== download.errorCode ? download.errorMessage : undefined) : download.errorMessage}${recoveryText ? ' · ' + recoveryText : ''}`} /></div>
		{/if}
		{#if download}
			<div class="content">
				<div class="info" class:selected={infoActive}>
					<NavScope bind:this={infoScope} options={infoOptions()}>
						<Table columns="auto 1fr" columnsMobile="auto 1fr" noBorder>
							{#each infoRows as row, index (row.label)}
								{@const rowSelected = infoScope?.controller.isSelected([0, index]) ?? false}
								<TableRow position={[0, index]}>
									<Cell>{row.label}:</Cell>
									{#if row.kind === 'description'}
										<Cell align="right" wrap><span class="description">{row.value}</span></Cell>
									{:else if row.kind === 'progress'}
										<Cell align="right"><span class="progress-value"><ProgressBar progress={download.progress} animated={download.status === 'downloading' || download.status === 'downloading-uploading' || download.status === 'verifying' || download.status === 'moving' || download.status === 'allocating'} /></span></Cell>
									{:else if row.kind === 'status'}
										<Cell align="right"><Badge label={$t('downloads.statuses.' + download.status)} status={download.status} /></Cell>
									{:else if row.kind === 'allowed'}
										<Cell align="right"><AllowedBadge mode={enabledMode} size="3vh" downloadColorVariable={rowSelected ? '--primary-background' : '--mode-download-fg'} uploadColorVariable={rowSelected ? '--primary-background' : '--mode-upload-fg'} disabledColorVariable={rowSelected ? '--primary-background' : '--mode-disabled-fg'} /></Cell>
									{:else}
										<Cell align="right">{row.value}</Cell>
									{/if}
								</TableRow>
							{/each}
						</Table>
					</NavScope>
				</div>
				<!-- Tab header + content -->
				<div class="container" bind:this={containerElement}>
					<NavScope bind:this={tabScope} options={tabOptions()}>
						<Tabs tabs={tabDefs} bind:activeID={activeTab} position={[0, 0]} compact onChange={handleTabChange} />
					</NavScope>
					{#if activeTab === 'files'}
						<NavScope bind:this={fileScope} options={fileListOptions()}>
							<Table columns="1fr 15vh 20vh" columnsMobile="1fr 13vh 10vh" noBorder>
								<Header fontSize="1.4vh">
									<Cell>{$t('common.name')}</Cell>
									<Cell align="center">{$t('common.size')}</Cell>
									<Cell align="center">{$t('common.progress')}</Cell>
								</Header>
								<div class="items">
									{#each download.files as file, index (file.id)}
										<!-- The wrapper keeps each row the last child of its own box, as before (no row borders). -->
										<div>
											<DownloadFile position={[0, index]} name={file.name} type={file.type} progress={fileDisplayProgress(file)} size={file.size} downloadedSize={file.downloadedSize} animated={(download.status === 'downloading' || download.status === 'downloading-uploading' || download.status === 'verifying' || download.status === 'moving' || download.status === 'allocating') && fileDisplayProgress(file) < 100} />
										</div>
									{/each}
								</div>
							</Table>
						</NavScope>
					{:else if !peerSnapshotLoaded}
						<div class="empty-peers">{$t('downloads.peerList.searching')}</div>
					{:else if currentPeers.length === 0}
						<div class="empty-peers">{$t('downloads.peerList.noPeers')}</div>
					{:else}
						<NavScope bind:this={peerScope} options={peerListOptions()}>
							<Table columns="2fr 2fr 8vh 6vh 12vh 12vh 8vh" columnsMobile="2fr 2fr 8vh 6vh 12vh 12vh 8vh" noBorder>
								<Header fontSize="1.3vh">
									<Cell>{$t('downloads.peerList.currentFile')}</Cell>
									<Cell>{$t('downloads.peerList.id')}</Cell>
									<Cell align="center">{$t('downloads.peerList.connection')}</Cell>
									<Cell align="center">{$t('downloads.peerList.availability')}</Cell>
									<Cell align="center">{$t('common.speed')}</Cell>
									<Cell align="center">{$t('common.transferred')}</Cell>
									<Cell align="center">{$t('downloads.peerList.activity')}</Cell>
								</Header>
								<div class="items">
									{#each currentPeers as peer, index (peer.peerID)}
										{@const ageSec = peer.lastActivity ? Math.max(0, Math.round((now - peer.lastActivity) / 1000)) : 0}
										{@const rowSelected = peerScope?.controller.isSelected([0, index]) ?? false}
										{@const downloadColor = rowSelected ? '--primary-background' : '--mode-download-fg'}
										{@const uploadColor = rowSelected ? '--primary-background' : '--mode-upload-fg'}
										<TableRow position={[0, index]} dimmed={peer.stale} onConfirm={() => openPeerDialog(peer)}>
											<Cell><span class="peer-file">{peer.currentFile ?? ''}</span></Cell>
											<Cell><span class="peer-id">{peer.peerID}</span></Cell>
											<Cell align="center"><span class="conn-badge" class:conn-direct={peer.connectionType === 'DIRECT'} class:conn-relay={peer.connectionType === 'RELAY'} class:conn-dcutr={peer.connectionType === 'DCUtR'}>{peer.connectionType}</span></Cell>
											<Cell align="center"><span class="peer-ago">{peer.havePercent != null ? `${peer.havePercent}%` : '—'}</span></Cell>
											<Cell align="center">
												<span class="peer-metric" class:sel={rowSelected}>
													<span class="speed-dl">
														<Icon img="/img/arrow-down.svg" size="1.4vh" padding="0" colorVariable={downloadColor} />
														<span>{formatSize(peer.downloadSpeed || 0)}/s</span>
													</span>
													<span class="speed-ul">
														<Icon img="/img/arrow-up.svg" size="1.4vh" padding="0" colorVariable={uploadColor} />
														<span>{formatSize(peer.uploadSpeed || 0)}/s</span>
													</span>
												</span>
											</Cell>
											<Cell align="center">
												<span class="peer-metric" class:sel={rowSelected}>
													<span class="total-dl">
														<Icon img="/img/arrow-down.svg" size="1.4vh" padding="0" colorVariable={downloadColor} />
														<span>{formatSize(peer.totalDownloaded || 0)}</span>
													</span>
													<span class="total-ul">
														<Icon img="/img/arrow-up.svg" size="1.4vh" padding="0" colorVariable={uploadColor} />
														<span>{formatSize(peer.totalUploaded || 0)}</span>
													</span>
												</span>
											</Cell>
											<Cell align="center"><span class="peer-ago">{ageSec}s</span></Cell>
										</TableRow>
									{/each}
								</div>
							</Table>
						</NavScope>
					{/if}
				</div>
			</div>
		{/if}
	</div>
	{#if showDeleteDialog && download}
		<DownloadDetailDelete lishID={download.id} lishName={download.name} {position} onResult={handleDeleteResult} onBack={handleDeleteCancel} />
	{/if}
	{#if showPeerDialog && download && selectedPeerSnapshot}
		<DownloadDetailPeer lishID={download.id} peerID={selectedPeerID} initialPeer={selectedPeerSnapshot} {position} onBack={handlePeerDialogBack} />
	{/if}
{/if}
