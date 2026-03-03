<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { splitPath, joinPath } from '../../scripts/fileBrowser.ts';
	import { api } from '../../scripts/api.ts';
	import { storageLISHnetPath, defaultMinifyJson, defaultCompress } from '../../scripts/settings.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	let unregisterArea: (() => void) | null = null;
	let removeBackHandler: (() => void) | null = null;
	let active = $derived($activeArea === areaID);
	let saving = $state(false);
	let selectedIndex = $state(0); // 0 = file path row, 1 = minify switch, 2 = gzip switch, 3 = buttons row
	let selectedColumn = $state(0); // row 0: 0=input,1=browse; row 3: 0=save,1=back
	let filePathInput: Input | undefined = $state();
	let browsingFolder = $state(false);
	let browseFolder = $state('');
	let minifyJsonState = $state($defaultMinifyJson);
	let compress = $state($defaultCompress);
	let errorMessage = $state('');
	let showOverwriteConfirm = $state(false);

	function generateFileName(): string {
		const now = new Date();
		const ts = now.getFullYear().toString() + '-' + (now.getMonth() + 1).toString().padStart(2, '0') + '-' + now.getDate().toString().padStart(2, '0') + '_' + now.getHours().toString().padStart(2, '0') + now.getMinutes().toString().padStart(2, '0') + now.getSeconds().toString().padStart(2, '0');
		return `networks_${ts}.lishnets`;
	}

	const initialFileName = generateFileName();
	let filePath = $state(joinPath($storageLISHnetPath, $defaultCompress ? initialFileName + '.gz' : initialFileName));

	function updateFileExtension(): void {
		if (filePath.endsWith('.lishnets') || filePath.endsWith('.lishnets.gz')) {
			if (compress && filePath.endsWith('.lishnets')) filePath = filePath + '.gz';
			else if (!compress && filePath.endsWith('.lishnets.gz')) filePath = filePath.slice(0, -3);
		}
	}

	function handleCompressToggle(): void {
		compress = !compress;
		updateFileExtension();
	}

	function openFolderBrowse(): void {
		const { folder } = splitPath(filePath.trim(), $storageLISHnetPath);
		browseFolder = folder;
		browsingFolder = true;
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb($t('common.openFolder'));
		removeBackHandler = pushBackHandler(handleBrowseBack);
	}

	function handleFolderSelect(folderPath: string): void {
		const { fileName } = splitPath(filePath.trim(), $storageLISHnetPath);
		filePath = joinPath(folderPath, fileName || generateFileName());
		handleBrowseBack();
	}

	async function handleBrowseBack(): Promise<void> {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		browsingFolder = false;
		await tick();
		unregisterArea = registerAreaHandler();
		selectedIndex = 0;
		selectedColumn = 1;
		activateArea(areaID);
	}

	async function handleSave(): Promise<void> {
		errorMessage = '';
		if (!filePath.trim()) {
			errorMessage = $t('common.filePathRequired');
			return;
		}
		const check = await api.fs.exists(filePath.trim());
		if (check.exists) {
			showOverwriteConfirm = true;
			return;
		}
		await doSave();
	}

	async function doSave(): Promise<void> {
		saving = true;
		errorMessage = '';
		try {
			const result = await api.lishnets.exportAllToFile(filePath.trim(), minifyJsonState, compress);
			if (result.success) {
				onBack?.();
				return;
			} else {
				errorMessage = 'Save failed';
			}
		} catch (e: any) {
			errorMessage = e?.message || 'Save failed';
		} finally {
			saving = false;
		}
	}

	function confirmOverwrite(): void {
		showOverwriteConfirm = false;
		doSave();
	}

	async function cancelOverwrite(): Promise<void> {
		showOverwriteConfirm = false;
		await tick();
		activateArea(areaID);
	}

	function registerAreaHandler(): () => void {
		return useArea(
			areaID,
			{
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
					if (selectedIndex === 0 && selectedColumn > 0) {
						selectedColumn--;
						return true;
					}
					if (selectedIndex === 3 && selectedColumn > 0) {
						selectedColumn--;
						return true;
					}
					return false;
				},
				right() {
					if (selectedIndex === 0 && selectedColumn < 1) {
						selectedColumn++;
						return true;
					}
					if (selectedIndex === 3 && selectedColumn < 1) {
						selectedColumn++;
						return true;
					}
					return false;
				},
				confirmDown() {
					if (selectedIndex === 0 && selectedColumn === 0) filePathInput?.focus();
				},
				confirmUp() {
					if (selectedIndex === 0 && selectedColumn === 1) openFolderBrowse();
					else if (selectedIndex === 1) minifyJsonState = !minifyJsonState;
					else if (selectedIndex === 2) handleCompressToggle();
					else if (selectedIndex === 3 && selectedColumn === 0) handleSave();
					else if (selectedIndex === 3 && selectedColumn === 1) onBack?.();
				},
				confirmCancel() {},
				back() {
					onBack?.();
				},
			},
			position
		);
	}

	onMount(() => {
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
		return () => {
			if (unregisterArea) unregisterArea();
		};
	});
</script>

<style>
	.export-all {
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

{#if browsingFolder}
	<FileBrowser {areaID} {position} initialPath={browseFolder} showPath foldersOnly selectFolderButton onSelect={handleFolderSelect} onBack={handleBrowseBack} />
{:else}
	<div class="export-all">
		<div class="container">
			<div class="row">
				<Input bind:this={filePathInput} bind:value={filePath} label={$t('common.file')} selected={active && selectedIndex === 0 && selectedColumn === 0} flex />
				<Button icon="/img/folder.svg" selected={active && selectedIndex === 0 && selectedColumn === 1} onConfirm={openFolderBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<SwitchRow label={$t('settings.lishNetwork.minifyJson')} checked={minifyJsonState} selected={active && selectedIndex === 1} onToggle={() => (minifyJsonState = !minifyJsonState)} />
			<SwitchRow label={$t('settings.lishNetwork.compress')} checked={compress} selected={active && selectedIndex === 2} onToggle={handleCompressToggle} />
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center">
			<Button icon="/img/save.svg" label={$t('common.save')} disabled={saving} selected={active && selectedIndex === 3 && selectedColumn === 0} onConfirm={handleSave} />
			<Button icon="/img/back.svg" label={$t('common.back')} selected={active && selectedIndex === 3 && selectedColumn === 1} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
{#if showOverwriteConfirm}
	<ConfirmDialog title={$t('common.overwriteFile')} message={$t('common.fileExistsOverwrite', { name: filePath })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmOverwrite} onBack={cancelOverwrite} />
{/if}
