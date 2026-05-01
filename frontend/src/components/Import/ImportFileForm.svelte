<script lang="ts" generics="TData">
	import { type Snippet } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { createSubPage } from '../../scripts/subPage.svelte.ts';
	import { localFilesystem } from '../../scripts/localFilesystem.ts';
	import { normalizePath } from '../../scripts/utils.ts';
	import Alert from '../Alert/Alert.svelte';
	import ButtonBar from '../Buttons/ButtonBar.svelte';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
	import SwitchRow from '../Switch/SwitchRow.svelte';
	import Dialog from '../Dialog/Dialog.svelte';
	import Spinner from '../Spinner/Spinner.svelte';
	import FileBrowser from '../../pages/FileBrowser/FileBrowser.svelte';

	interface ConfirmArgs {
		data: TData;
		onDone: () => void;
	}

	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		defaultDirectory: string;
		fileFilter: string[];
		fileFilterName: string;
		filePathLabel?: string | undefined;
		parseFile: (path: string) => Promise<TData>;
		parseJSON: (content: string) => Promise<TData>;
		downloadPath?: string | undefined;
		downloadPathLabel?: string | undefined;
		validate?: (() => string | null) | undefined;
		confirm: Snippet<[ConfirmArgs]>;
		onConfirmDone: () => void;
	}

	let { areaID, position = LAYOUT.content, onBack, defaultDirectory, fileFilter, fileFilterName, filePathLabel, parseFile, parseJSON, downloadPath = $bindable(), downloadPathLabel, validate, confirm, onConfirmDone }: Props = $props();

	let filePath = $state('');
	let uploadMode = $state(false);
	let uploadFileName = $state('');
	let uploadContent = $state('');
	let fileInput = $state<HTMLInputElement>();
	let errorMessage = $state('');
	let parsedData = $state<TData | null>(null);
	let importing = $state(false);

	const showDownloadPath = $derived(downloadPath !== undefined);
	const effectiveFilePathLabel = $derived(filePathLabel ?? $t('common.file'));
	const effectiveDownloadPathLabel = $derived(downloadPathLabel ?? $t('lish.import.downloadPath'));

	function openFilePicker(): void {
		fileInput?.click();
	}

	async function handleFileSelected(e: Event): Promise<void> {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		uploadFileName = file.name;
		errorMessage = '';
		try {
			if (file.name.endsWith('.gz') || file.name.endsWith('.gzip')) {
				const buffer = await file.arrayBuffer();
				const decompressed = new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip')));
				uploadContent = await decompressed.text();
			} else {
				uploadContent = await file.text();
			}
		} catch (err) {
			errorMessage = translateError(err);
			uploadContent = '';
		}
	}

	function toggleUploadMode(): void {
		uploadMode = !uploadMode;
	}

	async function handleImport(): Promise<void> {
		errorMessage = '';
		if (uploadMode) {
			if (!uploadContent.trim()) {
				errorMessage = $t('import.uploadRequired');
				return;
			}
		} else {
			if (!filePath.trim()) {
				errorMessage = $t('common.errorFilePathRequired');
				return;
			}
		}
		if (showDownloadPath && !downloadPath?.trim()) {
			errorMessage = $t('lish.import.downloadPathRequired');
			return;
		}
		if (validate) {
			const err = validate();
			if (err) {
				errorMessage = err;
				return;
			}
		}
		try {
			importing = true;
			parsedData = uploadMode ? await parseJSON(uploadContent) : await parseFile(filePath);
		} catch (e) {
			errorMessage = translateError(e);
		} finally {
			importing = false;
		}
	}

	function handleConfirmDone(): void {
		parsedData = null;
		onConfirmDone();
	}

	const navHandle = createNavArea(() => ({ areaID, position, activate: true, onBack }));
	const filePathSubPage = createSubPage(navHandle, () => areaID);
	const downloadPathSubPage = createSubPage(navHandle, () => areaID);

	function openFilePathBrowse(): void {
		filePathSubPage.enter(effectiveFilePathLabel);
	}

	function openDownloadPathBrowse(): void {
		downloadPathSubPage.enter(effectiveDownloadPathLabel);
	}

	function handleFilePathSelect(path: string): void {
		filePath = path;
		void filePathSubPage.exit();
	}

	function handleDownloadPathSelect(path: string): void {
		downloadPath = normalizePath(path);
		void downloadPathSubPage.exit();
	}

	function handleFilePathBrowseBack(): void {
		void filePathSubPage.exit();
	}

	function handleDownloadPathBrowseBack(): void {
		void downloadPathSubPage.exit();
	}
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

	.file-input {
		display: none;
	}

	.loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3vh;
		padding: 2vh 4vh;
	}

	.loading-label {
		font-size: 2vh;
		text-align: center;
	}
</style>

{#if parsedData}
	{@render confirm({ data: parsedData, onDone: handleConfirmDone })}
{:else if filePathSubPage.active}
	<FileBrowser {areaID} {position} initialPath={filePath || defaultDirectory} showPath {fileFilter} {fileFilterName} selectFileButton onSelect={handleFilePathSelect} onBack={handleFilePathBrowseBack} />
{:else if downloadPathSubPage.active && showDownloadPath}
	<FileBrowser {areaID} {position} initialPath={downloadPath ?? ''} directoriesOnly showPath selectDirectoryButton onSelect={handleDownloadPathSelect} onBack={handleDownloadPathBrowseBack} />
{:else}
	<input class="file-input" type="file" accept={fileFilter.join(',')} bind:this={fileInput} onchange={handleFileSelected} />
	<div class="import">
		<div class="container">
			{#if !$localFilesystem}
				<div role="group" data-mouse-activate-area={areaID}>
					<SwitchRow label={$t('import.uploadFromLocal')} checked={uploadMode} position={[0, 0]} onToggle={toggleUploadMode} />
				</div>
			{/if}
			{#if uploadMode}
				<div role="group" data-mouse-activate-area={areaID}>
					<Button icon="/img/upload.svg" label={uploadFileName || $t('import.selectLocalFile')} position={[0, 1]} onConfirm={openFilePicker} width="100%" />
				</div>
			{:else}
				<div class="row" role="group" data-mouse-activate-area={areaID}>
					<Input bind:value={filePath} label={effectiveFilePathLabel} position={[0, 1]} flex />
					<Button icon="/img/directory.svg" position={[1, 1]} onConfirm={openFilePathBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				</div>
			{/if}
			{#if showDownloadPath}
				<div class="row" role="group" data-mouse-activate-area={areaID}>
					<Input bind:value={downloadPath} label={effectiveDownloadPathLabel} position={[0, 2]} flex />
					<Button icon="/img/directory.svg" position={[1, 2]} onConfirm={openDownloadPathBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				</div>
			{/if}
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center" basePosition={[0, 3]}>
			<Button icon="/img/download.svg" label={$t('common.import')} onConfirm={handleImport} />
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
		</ButtonBar>
	</div>
	{#if importing}
		<Dialog title={$t('common.import')}>
			<div class="loading">
				<Spinner size="8vh" />
				<div class="loading-label">{$t('import.importing')}</div>
			</div>
		</Dialog>
	{/if}
{/if}
