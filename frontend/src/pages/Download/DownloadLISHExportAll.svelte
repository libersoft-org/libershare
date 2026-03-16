<script lang="ts">
	import { tick } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { splitPath, joinPath } from '../../scripts/fileBrowser.ts';
	import { api } from '../../scripts/api.ts';
	import { storageLISHPath, defaultMinifyJSON, defaultCompress } from '../../scripts/settings.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
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
	let { areaID, position = CONTENT_POSITIONS.main, onBack }: Props = $props();
	let removeBackHandler: (() => void) | null = null;
	let saving = $state(false);
	let browsingDirectory = $state(false);
	let browseDirectory = $state('');
	let minifyJSONState = $state($defaultMinifyJSON);
	let compress = $state($defaultCompress);
	let errorMessage = $state('');
	let showOverwriteConfirm = $state(false);

	function generateFileName(): string {
		const now = new Date();
		const ts = now.getFullYear().toString() + '-' + (now.getMonth() + 1).toString().padStart(2, '0') + '-' + now.getDate().toString().padStart(2, '0') + '_' + now.getHours().toString().padStart(2, '0') + now.getMinutes().toString().padStart(2, '0') + now.getSeconds().toString().padStart(2, '0');
		return `lishs_${ts}.lishs`;
	}

	const initialFileName = generateFileName();
	let filePath = $state(joinPath($storageLISHPath, $defaultCompress ? initialFileName + '.gz' : initialFileName));

	function updateFileExtension(): void {
		if (filePath.endsWith('.lishs') || filePath.endsWith('.lishs.gz')) {
			if (compress && filePath.endsWith('.lishs')) filePath = filePath + '.gz';
			else if (!compress && filePath.endsWith('.lishs.gz')) filePath = filePath.slice(0, -3);
		}
	}

	function handleCompressToggle(): void {
		compress = !compress;
		updateFileExtension();
	}

	const navHandle = createNavArea(() => ({ areaID, position, activate: true, onBack }));

	function openDirectoryBrowse(): void {
		const { directory } = splitPath(filePath.trim(), $storageLISHPath);
		browseDirectory = directory;
		browsingDirectory = true;
		navHandle.pause();
		pushBreadcrumb($t('common.openDirectory'));
		removeBackHandler = pushBackHandler(handleBrowseBack);
	}

	function handleDirectorySelect(directoryPath: string): void {
		const { fileName } = splitPath(filePath.trim(), $storageLISHPath);
		filePath = joinPath(directoryPath, fileName || generateFileName());
		handleBrowseBack();
	}

	async function handleBrowseBack(): Promise<void> {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		browsingDirectory = false;
		await tick();
		navHandle.resume();
		activateArea(areaID);
	}

	async function handleSave(): Promise<void> {
		errorMessage = '';
		if (!filePath.trim()) {
			errorMessage = $t('common.errorFilePathRequired');
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
			const result = await api.lishs.exportAllToFile(filePath.trim(), minifyJSONState, compress);
			if (result.success) {
				onBack?.();
				return;
			} else errorMessage = 'Save failed';
		} catch (e: any) {
			errorMessage = translateError(e);
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

{#if browsingDirectory}
	<FileBrowser {areaID} {position} initialPath={browseDirectory} showPath directoriesOnly selectDirectoryButton onSelect={handleDirectorySelect} onBack={handleBrowseBack} />
{:else}
	<div class="export-all">
		<div class="container">
			<div class="row">
				<Input bind:value={filePath} label={$t('common.file')} position={[0, 0]} flex />
				<Button icon="/img/directory.svg" position={[1, 0]} onConfirm={openDirectoryBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<SwitchRow label={$t('settings.lishNetwork.minifyJSON')} checked={minifyJSONState} position={[0, 1]} onToggle={() => (minifyJSONState = !minifyJSONState)} />
			<SwitchRow label={$t('settings.lishNetwork.compress')} checked={compress} position={[0, 2]} onToggle={handleCompressToggle} />
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center">
			<Button icon="/img/save.svg" label={$t('common.save')} disabled={saving} position={[0, 3]} onConfirm={handleSave} />
			<Button icon="/img/back.svg" label={$t('common.back')} position={[1, 3]} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
{#if showOverwriteConfirm}
	<ConfirmDialog title={$t('common.overwriteFile')} message={$t('common.errorFileExistsOverwrite', { name: filePath })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmOverwrite} onBack={cancelOverwrite} />
{/if}
