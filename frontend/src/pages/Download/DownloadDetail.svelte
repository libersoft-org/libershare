<script lang="ts">
	import { onMount } from 'svelte';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { t } from '../../scripts/language.ts';
	import { downloads, peerDetails, resetVerifyState, setCurrentDetailLISHID, DOWNLOAD_TOOLBAR_ACTIONS, handleDownloadToolbarAction, type DownloadToolbarActionID, computeEnabledMode } from '../../scripts/downloads.ts';
	import ModeBadge from '../../components/Badge/ModeBadge.svelte';
	import { scrollToElement, formatSize } from '../../scripts/utils.ts';
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
	let toolbarActive = $derived($activeArea === toolbarAreaID);
	let infoActive = $derived($activeArea === infoAreaID);
	let tabActive = $derived($activeArea === tabAreaID);
	let listActive = $derived($activeArea === listAreaID);
	let peerListActive = $derived($activeArea === peerListAreaID);
	let selectedToolbarIndex = $state(0);
	let selectedFileIndex = $state(0);
	let selectedTabIndex = $state(0); // 0=files, 1=peers
	let activeTab = $state<'files' | 'peers'>('files');
	let selectedPeerIndex = $state(0);
	let peerElements: HTMLElement[] = $state([]);
	let itemElements: HTMLElement[] = $state([]);
	let infoElement: HTMLElement | null = $state(null);
	// Per-peer data for this LISH
	let currentPeers = $derived(($peerDetails.get(lishID) ?? []).sort((a, b) => a.connectedAt - b.connectedAt));
	// Toolbar actions - adapt to current download state
	let isVerifying = $derived(download?.status === 'verifying' || download?.status === 'pending-verification');
	let isMoving = $derived(download?.status === 'moving');
	let isAllocating = $derived(download?.status === 'allocating');
	let isBusy = $derived(isVerifying || isMoving || isAllocating);
	let isDownloading = $derived(download?.downloadEnabled ?? false);
	let isUploading = $derived(download?.uploadEnabled ?? false);
	let downloadPaused = $derived(!isDownloading);
	let uploadPaused = $derived(!isUploading);
	let enabledMode = $derived(download ? computeEnabledMode(download.downloadEnabled, download.uploadEnabled) : 'disabled' as const);
	let toolbarActions = $derived(
		DOWNLOAD_TOOLBAR_ACTIONS.filter(action => {
			if (action.id === 'toggle-download') return true;
			if (action.id === 'toggle-upload') return true;
			if (action.id === 'move' && isBusy) return false;
			if (action.id === 'verify' && !isVerifying && !isDownloading && !isMoving) return true;
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
	// Export state
	let showExport = $state(false);
	// Move state
	let showMove = $state(false);
	// File browser state
	let showFileBrowser = $state(false);
	let removeFileBrowserBackHandler: (() => void) | null = null;

	let unregisterToolbar: (() => void) | null = null;
	let unregisterInfo: (() => void) | null = null;
	let unregisterTab: (() => void) | null = null;
	let unregisterList: (() => void) | null = null;
	let unregisterPeerList: (() => void) | null = null;

	function registerDetailAreas(): void {
		unregisterToolbar = useArea(toolbarAreaID, toolbarHandlers, position);
		unregisterInfo = useArea(infoAreaID, infoHandlers, position);
		unregisterTab = useArea(tabAreaID, tabHandlers, position);
		unregisterList = useArea(listAreaID, listHandlers, position);
		unregisterPeerList = useArea(peerListAreaID, peerListHandlers, position);
		activateArea(toolbarAreaID);
	}

	function unregisterDetailAreas(): void {
		unregisterToolbar?.();
		unregisterInfo?.();
		unregisterTab?.();
		unregisterList?.();
		unregisterPeerList?.();
		unregisterToolbar = null;
		unregisterInfo = null;
		unregisterTab = null;
		unregisterList = null;
		unregisterPeerList = null;
	}

	function handleExportBack(): void {
		showExport = false;
		registerDetailAreas();
	}

	function handleMoveBack(): void {
		popBreadcrumb();
		showMove = false;
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
		if (!success) deleteError = $t('downloads.deleteFailed');
		// Backend already handles verification after data-only delete (startVerification in del())
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
			activateArea(tabAreaID);
			return true;
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
			activateArea(tabAreaID);
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

	const tabHandlers = {
		up() { activateArea(toolbarAreaID); return true; },
		down() {
			if (activeTab === 'files' && download && download.files.length > 0) { activateArea(listAreaID); scrollToSelected(); return true; }
			if (activeTab === 'peers' && currentPeers.length > 0) { activateArea(peerListAreaID); return true; }
			return false;
		},
		left() { if (selectedTabIndex > 0) { selectedTabIndex--; activeTab = 'files'; return true; } return false; },
		right() { if (selectedTabIndex < 1) { selectedTabIndex++; activeTab = 'peers'; return true; } return false; },
		confirmDown() {},
		confirmUp() { activeTab = selectedTabIndex === 0 ? 'files' : 'peers'; },
		confirmCancel() {},
		back() { handleBack(); },
	};

	const peerListHandlers = {
		up() {
			if (selectedPeerIndex > 0) { selectedPeerIndex--; scrollToElement(peerElements, selectedPeerIndex); return true; }
			activateArea(tabAreaID);
			return true;
		},
		down() {
			if (selectedPeerIndex < currentPeers.length - 1) { selectedPeerIndex++; scrollToElement(peerElements, selectedPeerIndex); return true; }
			return false;
		},
		left() { return false; },
		right() { return false; },
		confirmDown() {},
		confirmUp() {},
		confirmCancel() {},
		back() { handleBack(); },
	};

	onMount(() => {
		setCurrentDetailLISHID(lishID);
		registerDetailAreas();
		// Subscribe to per-peer details for this LISH
		api.call('transfer.subscribePeers', { lishID });
		const clockInterval = setInterval(() => { now = Date.now(); }, 1000);
		return () => {
			clearInterval(clockInterval);
			setCurrentDetailLISHID(null);
			api.call('transfer.unsubscribePeers', { lishID });
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

	.tab-header {
		display: flex;
		gap: 0;
		border-bottom: 0.2vh solid var(--secondary-softer-background);
		flex-shrink: 0;
	}

	.tab {
		flex: 1;
		padding: 1vh 2vh;
		font-size: 1.4vh;
		background: transparent;
		border: none;
		color: var(--secondary-foreground);
		cursor: none;
		font-family: inherit;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.8vh;
	}

	.tab-icon {
		width: 1.8vh;
		height: 1.8vh;
		flex-shrink: 0;
	}

	.tab.active {
		color: var(--primary-foreground);
		border-bottom: 0.3vh solid var(--primary-foreground);
	}

	.tab.selected {
		background: var(--primary-foreground);
		color: var(--primary-background);
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
		opacity: 0.6;
	}

	.peer-id {
		font-family: 'Courier New', Consolas, monospace;
		font-size: 1.5vh;
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

	.peer-metric {
		display: flex;
		flex-direction: column;
		gap: 0.2vh;
		font-family: 'Courier New', Consolas, monospace;
		font-size: 1.5vh;
		white-space: nowrap;
	}

	.speed-dl, .total-dl {
		color: var(--mode-download-fg, #0c0);
	}

	.speed-ul, .total-ul {
		color: var(--mode-upload-fg, #28f);
	}

	.speed-idle {
		opacity: 0.35;
	}

	.speed-dl, .speed-ul {
		font-weight: bold;
	}

	.peer-file {
		font-size: 1.4vh;
		opacity: 0.7;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.peer-ago {
		font-size: 1.4vh;
		font-family: 'Courier New', Consolas, monospace;
		color: var(--secondary-foreground);
		opacity: 0.6;
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
{:else if showMove && download}
	<DownloadDetailMove {areaID} {position} lish={{ id: download.id, name: download.name, directory: download.directory }} onBack={handleMoveBack} />
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
		{#if download?.status === 'retrying' && download.retryErrorCode}
			<Alert type="warning" message={`${$t('downloads.statuses.retrying')}: ${download.retryErrorCode}${download.retryCount ? ` (${download.retryCount}/${download.retryMaxRetries ?? '?'})` : ''}`} />
		{/if}
		{#if download?.status === 'error' && (download.errorCode || download.errorMessage)}
			{@const recoveryText = download.recoveryNextAt === 0
				? $t('downloads.recoveryAttempting')
				: download.recoveryNextAt
					? $t('downloads.recoveryScheduled', { seconds: String(Math.max(1, Math.ceil((download.recoveryNextAt - now) / 1000))) })
					: ''}
			<Alert type="error" message={`${$t('downloads.statuses.error')}: ${download.errorCode ?? ''}${download.errorMessage && download.errorMessage !== download.errorCode ? ' — ' + download.errorMessage : ''}${recoveryText ? ' · ' + recoveryText : ''}`} />
		{/if}
		{#if download}
			<div class="content">
				<div class="info" class:selected={infoActive} bind:this={infoElement}>
					<Table columns="auto 1fr" columnsMobile="auto 1fr" noBorder>
						<TableRow>
							<Cell>{$t('downloads.id')}:</Cell>
							<Cell align="right">{download.id}</Cell>
						</TableRow>
						<TableRow>
							<Cell>{$t('common.name')}:</Cell>
							<Cell align="right">{download.name}</Cell>
						</TableRow>
						{#if download.description}
							<TableRow>
								<Cell>{$t('common.description')}:</Cell>
								<Cell align="right" wrap><span class="description">{download.description}</span></Cell>
							</TableRow>
						{/if}
						<TableRow>
							<Cell>{$t('downloads.targetDirectory')}:</Cell>
							<Cell align="right">{download.directory ?? '-'}</Cell>
						</TableRow>
						<TableRow>
							<Cell>{$t('common.size')}:</Cell>
							<Cell align="right">{download.downloadedSize ? `${download.downloadedSize} / ${download.size}` : download.size}</Cell>
						</TableRow>
						<TableRow>
							<Cell>{$t('common.progress')}:</Cell>
							<Cell align="right"><span class="progress-value"><ProgressBar progress={download.progress} animated={download.status === 'downloading' || download.status === 'downloading-uploading' || download.status === 'verifying' || download.status === 'moving' || download.status === 'allocating'} /></span></Cell>
						</TableRow>
						<TableRow>
							<Cell>{$t('common.status')}:</Cell>
							<Cell align="right"><Badge label={$t('downloads.statuses.' + download.status)} status={download.status} /></Cell>
						</TableRow>
						<TableRow>
							<Cell>{$t('downloads.mode')}:</Cell>
							<Cell align="right"><ModeBadge mode={enabledMode} size="3vh" /></Cell>
						</TableRow>
						<TableRow>
							<Cell>{$t('downloads.downloadingFrom')}:</Cell>
							<Cell align="right">{download.downloadPeers}</Cell>
						</TableRow>
						<TableRow>
							<Cell>{$t('downloads.uploadingTo')}:</Cell>
							<Cell align="right">{download.uploadPeers}</Cell>
						</TableRow>
						<TableRow>
							<Cell>{$t('downloads.downloadSpeed')}:</Cell>
							<Cell align="right">{download.downloadSpeed}</Cell>
						</TableRow>
						<TableRow>
							<Cell>{$t('downloads.uploadSpeed')}:</Cell>
							<Cell align="right">{download.uploadSpeed}</Cell>
						</TableRow>
						<TableRow>
							<Cell>{$t('downloads.downloaded')}:</Cell>
							<Cell align="right">{formatSize(download.totalDownloadedBytes)}</Cell>
						</TableRow>
						<TableRow>
							<Cell>{$t('downloads.uploaded')}:</Cell>
							<Cell align="right">{formatSize(download.totalUploadedBytes)}</Cell>
						</TableRow>
					</Table>
				</div>
				<!-- Tab header + content -->
				<div class="container">
					<div class="tab-header">
						<button class="tab" class:active={activeTab === 'files'} class:selected={tabActive && selectedTabIndex === 0}>
							<svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
								<polyline points="14 2 14 8 20 8"/>
								<line x1="16" y1="13" x2="8" y2="13"/>
								<line x1="16" y1="17" x2="8" y2="17"/>
								<polyline points="10 9 9 9 8 9"/>
							</svg>
							{$t('downloads.tabs.files')}
						</button>
						<button class="tab" class:active={activeTab === 'peers'} class:selected={tabActive && selectedTabIndex === 1}>
							<svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<circle cx="18" cy="5" r="3"/>
								<circle cx="6" cy="12" r="3"/>
								<circle cx="18" cy="19" r="3"/>
								<line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
								<line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
							</svg>
							{$t('downloads.tabs.peers')}
						</button>
					</div>
					{#if activeTab === 'files'}
						<Table columns="1fr 15vh 20vh" columnsMobile="1fr 13vh 10vh" noBorder>
							<Header fontSize="1.4vh">
								<Cell>{$t('common.name')}</Cell>
								<Cell align="center">{$t('common.size')}</Cell>
								<Cell align="center">{$t('common.progress')}</Cell>
							</Header>
							<div class="items">
								{#each download.files as file, index (file.id)}
									<DownloadFile bind:el={itemElements[index]} name={file.name} type={file.type} progress={file.progress} size={file.size} downloadedSize={file.downloadedSize} selected={listActive && selectedFileIndex === index} animated={(download.status === 'downloading' || download.status === 'downloading-uploading' || download.status === 'verifying' || download.status === 'moving' || download.status === 'allocating') && file.progress < 100} />
								{/each}
							</div>
						</Table>
					{:else}
						{#if currentPeers.length === 0}
							<div class="empty-peers">{$t('downloads.peerList.searching')}</div>
						{:else}
							<Table columns="14vh 8vh 1fr 1fr 9vh 2fr" columnsMobile="14vh 8vh 1fr 1fr 9vh" noBorder>
								<Header fontSize="1.3vh">
									<Cell>{$t('downloads.peerList.id')}</Cell>
									<Cell align="center">{$t('downloads.peerList.connection')}</Cell>
									<Cell align="right">{$t('downloads.peerList.speed')}</Cell>
									<Cell align="right">{$t('downloads.peerList.transferred')}</Cell>
									<Cell align="right">{$t('downloads.peerList.activity')}</Cell>
									<Cell>{$t('downloads.peerList.currentFile')}</Cell>
								</Header>
								<div class="items">
									{#each currentPeers as peer, index (peer.peerID)}
										{@const ageSec = peer.lastActivity ? Math.max(0, Math.round((now - peer.lastActivity) / 1000)) : 0}
										<TableRow bind:el={peerElements[index]} selected={peerListActive && selectedPeerIndex === index} dimmed={peer.stale}>
											<Cell><span class="peer-id">{peer.peerID}</span></Cell>
											<Cell align="center"><span class="conn-badge" class:conn-direct={peer.connectionType === 'DIRECT'} class:conn-relay={peer.connectionType === 'RELAY'}>{peer.connectionType}</span></Cell>
											<Cell align="right">
												<span class="peer-metric">
													<span class="speed-dl" class:speed-idle={!peer.downloadSpeed}>↓ {formatSize(peer.downloadSpeed || 0)}/s</span>
													<span class="speed-ul" class:speed-idle={!peer.uploadSpeed}>↑ {formatSize(peer.uploadSpeed || 0)}/s</span>
												</span>
											</Cell>
											<Cell align="right">
												<span class="peer-metric">
													<span class="total-dl">↓ {formatSize(peer.totalDownloaded || 0)}</span>
													<span class="total-ul">↑ {formatSize(peer.totalUploaded || 0)}</span>
												</span>
											</Cell>
											<Cell align="right"><span class="peer-ago">{ageSec}s</span></Cell>
											<Cell><span class="peer-file">{peer.currentFile ?? ''}</span></Cell>
										</TableRow>
									{/each}
								</div>
							</Table>
						{/if}
					{/if}
				</div>
			</div>
		{/if}
	</div>
	{#if showDeleteDialog && download}
		<DownloadDetailDelete lishID={download.id} lishName={download.name} {position} onResult={handleDeleteResult} onBack={handleDeleteCancel} />
	{/if}
{/if}
