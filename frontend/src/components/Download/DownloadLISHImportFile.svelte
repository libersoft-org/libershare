<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { storagePath } from '../../scripts/settings.ts';
	import Alert from '../Alert/Alert.svelte';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';

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
	// 0 = file path, 1 = download path, 2 = buttons row
	let selectedIndex = $state(0);
	let selectedColumn = $state(0);
	let filePathRef: Input;
	let downloadPathRef: Input;
	let filePath = $state('');
	let downloadPath = $state($storagePath);
	let errorMessage = $state('');
	let browsingFilePath = $state(false);
	let browsingDownloadPath = $state(false);

	function getMaxColumn(index: number): number {
		if (index === 0) return 1; // file path + browse
		if (index === 1) return 1; // download path + browse
		if (index === 2) return 1; // import, back
		return 0;
	}

	function handleImport() {
		errorMessage = '';
		if (!filePath.trim()) {
			errorMessage = $t.downloads?.lishImport?.filePathRequired || 'File path is required';
			return;
		}
		if (!downloadPath.trim()) {
			errorMessage = $t.downloads?.lishImport?.downloadPathRequired || 'Download folder is required';
			return;
		}
		// TODO: Load and parse LISH file from filePath
		// TODO: Add LISH items to storage/backend
		onImport?.();
	}

	function openFilePathBrowse() {
		browsingFilePath = true;
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb($t.downloads?.lishImport?.filePath || 'LISH File');
		removeBackHandler = pushBackHandler(handleBrowseBack);
	}

	function openDownloadPathBrowse() {
		browsingDownloadPath = true;
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb($t.downloads?.lishImport?.downloadPath);
		removeBackHandler = pushBackHandler(handleBrowseBack);
	}

	function handleFilePathSelect(path: string) {
		filePath = path;
		handleBrowseBack();
	}

	function handleDownloadPathSelect(path: string) {
		const normalizedPath = path.endsWith('/') || path.endsWith('\\') ? path : path + '/';
		downloadPath = normalizedPath;
		handleBrowseBack();
	}

	async function handleBrowseBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		browsingFilePath = false;
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
			if (selectedIndex < 2) {
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
			if (selectedIndex === 0 && selectedColumn === 0) filePathRef?.focus();
			else if (selectedIndex === 1 && selectedColumn === 0) downloadPathRef?.focus();
		},
		confirmUp: () => {
			if (selectedIndex === 0 && selectedColumn === 1) {
				openFilePathBrowse();
			} else if (selectedIndex === 1 && selectedColumn === 1) {
				openDownloadPathBrowse();
			} else if (selectedIndex === 2) {
				if (selectedColumn === 0) {
					handleImport();
				} else if (selectedColumn === 1) {
					onBack?.();
				}
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

{#if browsingFilePath}
	<FileBrowser {areaID} {position} initialPath={filePath || $storagePath} showPath onSelect={handleFilePathSelect} onBack={handleBrowseBack} />
{:else if browsingDownloadPath}
	<FileBrowser {areaID} {position} initialPath={downloadPath} foldersOnly showPath onSelect={handleDownloadPathSelect} onBack={handleBrowseBack} />
{:else}
	<div class="import">
		<div class="container">
			<div class="row">
				<Input bind:this={filePathRef} bind:value={filePath} label={$t.downloads?.lishImport?.filePath} selected={active && selectedIndex === 0 && selectedColumn === 0} flex />
				<Button icon="/img/folder.svg" selected={active && selectedIndex === 0 && selectedColumn === 1} onConfirm={openFilePathBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row">
				<Input bind:this={downloadPathRef} bind:value={downloadPath} label={$t.downloads?.lishImport?.downloadPath} selected={active && selectedIndex === 1 && selectedColumn === 0} flex />
				<Button icon="/img/folder.svg" selected={active && selectedIndex === 1 && selectedColumn === 1} onConfirm={openDownloadPathBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<div class="buttons">
			<Button icon="/img/download.svg" label={$t.common?.import} selected={active && selectedIndex === 2 && selectedColumn === 0} onConfirm={handleImport} />
			<Button icon="/img/back.svg" label={$t.common?.back} selected={active && selectedIndex === 2 && selectedColumn === 1} onConfirm={onBack} />
		</div>
	</div>
{/if}
