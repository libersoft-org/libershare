<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { importNetworksFromJson, getNetworkErrorMessage } from '../../scripts/lishNetwork.ts';
	import { storageLishnetPath } from '../../scripts/settings.ts';
	import { api } from '../../scripts/api.ts';
	import Alert from '../../components/Alert/Alert.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';

	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
		onImport?: () => void;
	}
	let { areaID, position = LAYOUT.content, onBack, onImport }: Props = $props();
	let unregisterArea: (() => void) | null = null;
	let removeBackHandler: (() => void) | null = null;
	let active = $derived($activeArea === areaID);
	// 0 = file path, 1 = buttons row
	let selectedIndex = $state(0);
	let selectedColumn = $state(0);
	let filePathRef: Input | undefined = $state();
	let filePath = $state('');
	let errorMessage = $state('');
	let browsingFilePath = $state(false);

	function getMaxColumn(index: number): number {
		if (index === 0) return 1; // file path + browse
		if (index === 1) return 1; // import, back
		return 0;
	}

	async function handleImport() {
		errorMessage = '';
		if (!filePath.trim()) {
			errorMessage = $t('settings.lishNetworkImport.filePathRequired');
			return;
		}
		try {
			// Read file from backend using WebSocket API
			// Use readGzip for .gz files, readText otherwise
			const isGzip = filePath.toLowerCase().endsWith('.gz');
			const content = isGzip ? await api.fs.readGzip(filePath) : await api.fs.readText(filePath);
			const result = await importNetworksFromJson(content);
			if (result.error) {
				errorMessage = getNetworkErrorMessage(result.error, $t);
				return;
			}
			onImport?.();
			onBack?.();
			onBack?.();
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : String(e);
		}
	}

	function openFilePathBrowse() {
		browsingFilePath = true;
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb($t('settings.lishNetworkImport.filePath'));
		removeBackHandler = pushBackHandler(handleBrowseBack);
	}

	function handleFilePathSelect(path: string) {
		filePath = path;
		handleBrowseBack();
	}

	async function handleBrowseBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		browsingFilePath = false;
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
			if (selectedIndex < 1) {
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
		},
		confirmUp: () => {
			if (selectedIndex === 0 && selectedColumn === 1) {
				openFilePathBrowse();
			} else if (selectedIndex === 1) {
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
	<FileBrowser {areaID} {position} initialPath={filePath || $storageLishnetPath} showPath fileFilter={['*.lishnet', '*.lishnets', '*.json', '*.lishnet.gz', '*.lishnets.gz', '*.json.gz']} selectFileButton onSelect={handleFilePathSelect} onBack={handleBrowseBack} />
{:else}
	<div class="import">
		<div class="container">
			<div class="row">
				<Input bind:this={filePathRef} bind:value={filePath} label={$t('settings.lishNetworkImport.filePath')} selected={active && selectedIndex === 0 && selectedColumn === 0} flex />
				<Button icon="/img/folder.svg" selected={active && selectedIndex === 0 && selectedColumn === 1} onConfirm={openFilePathBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<div class="buttons">
			<Button icon="/img/download.svg" label={$t('common.import')} selected={active && selectedIndex === 1 && selectedColumn === 0} onConfirm={handleImport} />
			<Button icon="/img/back.svg" label={$t('common.back')} selected={active && selectedIndex === 1 && selectedColumn === 1} onConfirm={onBack} />
		</div>
	</div>
{/if}
