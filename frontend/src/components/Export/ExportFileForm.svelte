<script lang="ts">
	import { tick } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { createSubPage } from '../../scripts/subPage.svelte.ts';
	import { splitPath, joinPath } from '../../scripts/fileBrowser.ts';
	import { api } from '../../scripts/api.ts';
	import { defaultMinifyJSON, defaultCompress } from '../../scripts/settings.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	import FileBrowser from '../../pages/FileBrowser/FileBrowser.svelte';

	export interface ExportOptions {
		minifyJSON: boolean;
		compress: boolean;
	}

	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		filePath: string;
		defaultDirectory: string;
		extension: string; // file extension without leading dot, e.g. 'json', 'lish', 'lishnet'
		fallbackFileName: string; // used when directory is selected and no filename is set
		validate?: (() => string | null) | undefined;
		doExport: (filePath: string, options: ExportOptions) => Promise<{ success: boolean }>;
		onSuccess: () => void;
	}

	let { areaID, position = LAYOUT.content, onBack, filePath = $bindable(), defaultDirectory, extension, fallbackFileName, validate, doExport, onSuccess }: Props = $props();
	let saving = $state(false);
	let browseDirectory = $state('');
	let minifyJSONState = $state($defaultMinifyJSON);
	let compress = $state($defaultCompress);
	let errorMessage = $state('');
	let showOverwriteConfirm = $state(false);

	function updateFileExtension(): void {
		const ext = '.' + extension;
		const extGz = ext + '.gz';
		if (filePath.endsWith(ext) || filePath.endsWith(extGz)) {
			if (compress && filePath.endsWith(ext)) filePath = filePath + '.gz';
			else if (!compress && filePath.endsWith(extGz)) filePath = filePath.slice(0, -3);
		}
	}

	function handleCompressToggle(): void {
		compress = !compress;
		updateFileExtension();
	}

	const navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));
	const browseSubPage = createSubPage(navHandle, () => areaID);

	function openDirectoryBrowse(): void {
		const { directory } = splitPath(filePath.trim(), defaultDirectory);
		browseDirectory = directory;
		browseSubPage.enter($t('common.openDirectory'));
	}

	function handleDirectorySelect(directoryPath: string): void {
		const { fileName } = splitPath(filePath.trim(), defaultDirectory);
		filePath = joinPath(directoryPath, fileName || fallbackFileName);
		void browseSubPage.exit();
	}

	function handleBrowseBack(): void {
		void browseSubPage.exit();
	}

	async function handleSave(): Promise<void> {
		errorMessage = '';
		if (!filePath.trim()) {
			errorMessage = $t('common.errorFilePathRequired');
			return;
		}
		if (validate) {
			const err = validate();
			if (err) {
				errorMessage = err;
				return;
			}
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
			const result = await doExport(filePath.trim(), { minifyJSON: minifyJSONState, compress });
			if (result.success) {
				onSuccess();
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
		void doSave();
	}

	async function cancelOverwrite(): Promise<void> {
		showOverwriteConfirm = false;
		await tick();
		activateArea(areaID);
	}
</script>

<style>
	.export {
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

{#if browseSubPage.active}
	<FileBrowser {areaID} {position} initialPath={browseDirectory} showPath directoriesOnly selectDirectoryButton onSelect={handleDirectorySelect} onBack={handleBrowseBack} />
{:else}
	<div class="export">
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
		<ButtonBar justify="center" basePosition={[0, 3]}>
			<Button icon="/img/save.svg" label={$t('common.save')} disabled={saving} onConfirm={handleSave} />
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
{#if showOverwriteConfirm}
	<ConfirmDialog title={$t('common.overwriteFile')} message={$t('common.errorFileExistsOverwrite', { name: filePath })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmOverwrite} onBack={cancelOverwrite} />
{/if}
