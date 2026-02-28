<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { parseLISHFromJson, getLISHErrorMessage } from '../../scripts/lish.ts';
	import { storagePath, autoStartSharing } from '../../scripts/settings.ts';
	import { normalizePath } from '../../scripts/utils.ts';
	import { api } from '../../scripts/api.ts';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		initialFilePath?: string | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = CONTENT_POSITIONS.main, initialFilePath = '', onBack, onImport }: Props = $props();
	let unregisterArea: (() => void) | null = null;
	let removeBackHandler: (() => void) | null = null;
	let active = $derived($activeArea === areaID);
	// 0 = json input, 1 = download path, 2 = auto start switch, 3 = buttons row
	let selectedIndex = $state(0);
	let selectedColumn = $state(0);
	let inputRef: Input | undefined = $state();
	let downloadPathRef: Input | undefined = $state();
	let lishJson = $state('');
	let downloadPath = $state($storagePath);
	let autoStart = $state($autoStartSharing);
	let errorMessage = $state('');
	let browsingDownloadPath = $state(false);

	function getMaxColumn(index: number): number {
		if (index === 1) return 1; // download path + browse
		if (index === 2) return 0; // auto start switch
		if (index === 3) return 1; // import, back
		return 0;
	}

	function handleImport(): void {
		errorMessage = '';
		if (!downloadPath.trim()) {
			errorMessage = $t('downloads.lishImport.downloadPathRequired');
			return;
		}
		const result = parseLISHFromJson(lishJson);
		if (result.error) {
			errorMessage = getLISHErrorMessage(result.error, $t);
			return;
		}
		// TODO: Add LISH items to storage/backend
		// result.items contains validated LISH objects
		onImport?.();
	}

	function openDownloadPathBrowse(): void {
		browsingDownloadPath = true;
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb($t('downloads.lishImport.downloadPath'));
		removeBackHandler = pushBackHandler(handleBrowseBack);
	}

	function handleBrowseSelect(path: string): void {
		downloadPath = normalizePath(path);
		handleBrowseBack();
	}

	async function handleBrowseBack(): Promise<void> {
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

	function registerAreaHandler(): () => void {
		return useArea(areaID, areaHandlers, position);
	}

	async function loadInitialFile(): Promise<void> {
		if (initialFilePath) {
			try {
				const isGzip = initialFilePath.toLowerCase().endsWith('.gz');
				const content = isGzip ? await api.fs.readGzip(initialFilePath) : await api.fs.readText(initialFilePath);
				if (content) {
					// Pretty-print minified JSON for readability
					try {
						const parsed = JSON.parse(content);
						lishJson = JSON.stringify(parsed, null, '\t');
					} catch {
						lishJson = content;
					}
				}
			} catch (e) {
				// Ignore error, user can still paste JSON manually
			}
		}
	}

	const areaHandlers = {
		up() {
			if (selectedIndex > 0) {
				selectedIndex--;
				selectedColumn = 0;
				return true;
			}
			return false;
		},
		down() {
			if (selectedIndex < 3) {
				selectedIndex++;
				selectedColumn = 0;
				return true;
			}
			return false;
		},
		left() {
			if (selectedColumn > 0) {
				selectedColumn--;
				return true;
			}
			return false;
		},
		right() {
			const maxCol = getMaxColumn(selectedIndex);
			if (selectedColumn < maxCol) {
				selectedColumn++;
				return true;
			}
			return false;
		},
		confirmDown() {
			if (selectedIndex === 0) inputRef?.focus();
			else if (selectedIndex === 1 && selectedColumn === 0) downloadPathRef?.focus();
		},
		confirmUp() {
			if (selectedIndex === 1 && selectedColumn === 1) {
				openDownloadPathBrowse();
			} else if (selectedIndex === 2) {
				autoStart = !autoStart;
			} else if (selectedIndex === 3) {
				if (selectedColumn === 0) {
					handleImport();
				} else if (selectedColumn === 1) {
					onBack?.();
				}
			}
		},
		confirmCancel() {},
		back() { onBack?.(); },
	};

	onMount(() => {
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
		loadInitialFile();
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

	.row {
		display: flex;
		gap: 1vh;
		align-items: flex-end;
	}
</style>

{#if browsingDownloadPath}
	<FileBrowser {areaID} {position} initialPath={downloadPath} foldersOnly showPath selectFolderButton onSelect={handleBrowseSelect} onBack={handleBrowseBack} />
{:else}
	<div class="import">
		<div class="container">
			<Input bind:this={inputRef} bind:value={lishJson} label={$t('downloads.lishImport.lishJSON')} multiline rows={10} placeholder={$t('downloads.lishImport.placeholder')} fontSize="2vh" fontFamily="'Ubuntu Mono'" selected={active && selectedIndex === 0} />
			<div class="row">
				<Input bind:this={downloadPathRef} bind:value={downloadPath} label={$t('downloads.lishImport.downloadPath')} selected={active && selectedIndex === 1 && selectedColumn === 0} flex />
				<Button icon="/img/folder.svg" selected={active && selectedIndex === 1 && selectedColumn === 1} onConfirm={openDownloadPathBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<SwitchRow label={$t('downloads.lishImport.autoStartSharing')} checked={autoStart} selected={active && selectedIndex === 2} onToggle={() => (autoStart = !autoStart)} />
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center">
			<Button icon="/img/download.svg" label={$t('common.import')} selected={active && selectedIndex === 3 && selectedColumn === 0} onConfirm={handleImport} />
			<Button icon="/img/back.svg" label={$t('common.back')} selected={active && selectedIndex === 3 && selectedColumn === 1} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
