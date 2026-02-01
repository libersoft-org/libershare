<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { storagePath, autoStartSharing } from '../../scripts/settings.ts';
	import { normalizePath } from '../../scripts/utils.ts';
	import { parseLISHFromJson, getLISHErrorMessage } from '../../scripts/lish.ts';
	import { api } from '../../scripts/api.ts';
	import Alert from '../../components/Alert/Alert.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';

	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
		onImport?: () => void;
	}
	let { areaID, position = CONTENT_POSITIONS.main, onBack, onImport }: Props = $props();
	let unregisterArea: (() => void) | null = null;
	let removeBackHandler: (() => void) | null = null;
	let active = $derived($activeArea === areaID);
	// 0 = url, 1 = download path, 2 = auto start switch, 3 = buttons row
	let selectedIndex = $state(0);
	let selectedColumn = $state(0);
	let urlRef: Input | undefined = $state();
	let downloadPathRef: Input | undefined = $state();
	let url = $state('');
	let downloadPath = $state($storagePath);
	let autoStart = $state($autoStartSharing);
	let errorMessage = $state('');
	let loading = $state(false);
	let browsingDownloadPath = $state(false);

	function getMaxColumn(index: number): number {
		if (index === 1) return 1; // download path + browse
		if (index === 2) return 0; // auto start switch
		if (index === 3) return 1; // import, back
		return 0;
	}

	async function handleImport() {
		errorMessage = '';
		if (!url.trim()) {
			errorMessage = $t('downloads.lishImport.urlRequired');
			return;
		}
		if (!downloadPath.trim()) {
			errorMessage = $t('downloads.lishImport.downloadPathRequired');
			return;
		}
		loading = true;
		try {
			// Use backend API to bypass CORS restrictions
			const response = await api.fetchUrl(url);
			if (response.status !== 200) {
				errorMessage = `HTTP ${response.status}`;
				return;
			}
			const result = parseLISHFromJson(response.content);
			if (result.error) {
				errorMessage = getLISHErrorMessage(result.error, $t);
				return;
			}
			// TODO: Add LISH items to storage/backend
			// result.items contains validated LISH objects
			onImport?.();
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	function openDownloadPathBrowse() {
		browsingDownloadPath = true;
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb($t('downloads.lishImport.downloadPath'));
		removeBackHandler = pushBackHandler(handleBrowseBack);
	}

	function handleDownloadPathSelect(path: string) {
		downloadPath = normalizePath(path);
		handleBrowseBack();
	}

	async function handleBrowseBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		browsingDownloadPath = false;
		await tick();
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
	}

	function registerAreaHandler() {
		return useArea(areaID, areaHandlers, position);
	}

	const areaHandlers = {
		up: () => {
			if (selectedIndex > 0) {
				selectedIndex--;
				selectedColumn = 0;
				return true;
			}
			return false;
		},
		down: () => {
			if (selectedIndex < 3) {
				selectedIndex++;
				selectedColumn = 0;
				return true;
			}
			return false;
		},
		left: () => {
			if (selectedColumn > 0) {
				selectedColumn--;
				return true;
			}
			return false;
		},
		right: () => {
			const maxCol = getMaxColumn(selectedIndex);
			if (selectedColumn < maxCol) {
				selectedColumn++;
				return true;
			}
			return false;
		},
		confirmDown: () => {
			if (selectedIndex === 0) urlRef?.focus();
			else if (selectedIndex === 1 && selectedColumn === 0) downloadPathRef?.focus();
		},
		confirmUp: () => {
			if (selectedIndex === 1 && selectedColumn === 1) {
				openDownloadPathBrowse();
			} else if (selectedIndex === 2) {
				autoStart = !autoStart;
			} else if (selectedIndex === 3) {
				if (selectedColumn === 0) handleImport();
				else if (selectedColumn === 1) onBack?.();
			}
		},
		confirmCancel: () => {},
		back: () => onBack?.(),
	};

	onMount(() => {
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
		return () => {
			if (unregisterArea) unregisterArea();
		};
	});
</script>

<style>
	.import {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh;
		gap: 2vh;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		width: 800px;
		max-width: 100%;
	}

	.buttons {
		display: flex;
		justify-content: center;
		gap: 2vh;
	}

	.row {
		display: flex;
		gap: 1vh;
		align-items: flex-end;
	}
</style>

{#if browsingDownloadPath}
	<FileBrowser {areaID} {position} initialPath={downloadPath} foldersOnly showPath selectFolderButton onSelect={handleDownloadPathSelect} onBack={handleBrowseBack} />
{:else}
	<div class="import">
		<div class="container">
			<Input bind:this={urlRef} bind:value={url} label={$t('downloads.lishImport.url')} placeholder="https://..." selected={active && selectedIndex === 0} flex />
			<div class="row">
				<Input bind:this={downloadPathRef} bind:value={downloadPath} label={$t('downloads.lishImport.downloadPath')} selected={active && selectedIndex === 1 && selectedColumn === 0} flex />
				<Button icon="/img/folder.svg" selected={active && selectedIndex === 1 && selectedColumn === 1} onConfirm={openDownloadPathBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<SwitchRow label={$t('downloads.lishImport.autoStartSharing')} checked={autoStart} selected={active && selectedIndex === 2} onToggle={() => (autoStart = !autoStart)} />
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<div class="buttons">
			<Button icon="/img/download.svg" label={$t('common.import')} selected={active && selectedIndex === 3 && selectedColumn === 0} onConfirm={handleImport} disabled={loading} />
			<Button icon="/img/back.svg" label={$t('common.back')} selected={active && selectedIndex === 3 && selectedColumn === 1} onConfirm={onBack} />
		</div>
	</div>
{/if}
