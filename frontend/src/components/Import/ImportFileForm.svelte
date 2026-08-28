<script lang="ts" generics="TData">
	import { onDestroy, type Snippet } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { createSubPage } from '../../scripts/subPage.svelte.ts';
	import { localFilesystem } from '../../scripts/localFilesystem.ts';
	import { normalizePath } from '../../scripts/utils.ts';
	import { api } from '../../scripts/api.ts';
	import { uploadImportFile } from '../../scripts/ws-client.ts';
	import { createImportOperationController, createImportUploader } from '../../scripts/importUpload.ts';
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
		/** Parse a file the user pointed at by path, on a machine with a local filesystem. */
		parseFile: (path: string) => Promise<TData>;
		/** Parse a file the user uploaded. The backend reads and deletes it by id. */
		parseUpload: (uploadID: string) => Promise<TData>;
		downloadPath?: string | undefined;
		downloadPathLabel?: string | undefined;
		validate?: (() => string | null) | undefined;
		confirm: Snippet<[ConfirmArgs]>;
		onConfirmDone: () => void;
	}

	let { areaID, position = LAYOUT.content, onBack, defaultDirectory, fileFilter, fileFilterName, filePathLabel, parseFile, parseUpload, downloadPath = $bindable(), downloadPathLabel, validate, confirm, onConfirmDone }: Props = $props();

	let filePath = $state('');
	let uploadMode = $state(false);
	let uploadFileName = $state('');
	/** Id the backend holds the uploaded file under, empty until one is picked. */
	let uploadID = $state('');
	let fileInput = $state<HTMLInputElement>();
	let errorMessage = $state('');
	let parsedData = $state<TData | null>(null);
	/** Label shown in the blocking dialog, empty while nothing is running. */
	let busyLabel = $state('');
	const operations = createImportOperationController(label => (busyLabel = label));

	const uploader = createImportUploader(
		{
			setUploadID: id => (uploadID = id),
			setFileName: name => (uploadFileName = name),
			setError: message => (errorMessage = message),
		},
		{
			upload: uploadImportFile,
			discard: id => api.upload.abort(id),
			uploadingLabel: () => $t('import.uploading'),
			formatError: translateError,
		},
		operations
	);

	const showDownloadPath = $derived(downloadPath !== undefined);
	const effectiveFilePathLabel = $derived(filePathLabel ?? $t('common.file'));
	const effectiveDownloadPathLabel = $derived(downloadPathLabel ?? $t('lish.import.downloadPath'));

	function openFilePicker(): void {
		fileInput?.click();
	}

	async function handleFileSelected(e: Event): Promise<void> {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		// Cleared immediately: the picker fires no change event when the same file
		// is chosen twice in a row, so after a failed upload or a failed parse the
		// user could not retry with that file at all.
		input.value = '';
		if (!file) return;
		await uploader.pick(file);
	}

	function toggleUploadMode(): void {
		uploadMode = !uploadMode;
		operations.invalidate();
	}

	// Leaving the form after picking a file but before importing it — Back, a
	// mode switch followed by a path import, any navigation away — would strand
	// the uploaded copy on the backend's disk until it ages out.
	onDestroy(() => {
		uploader.unmount();
	});

	async function handleImport(): Promise<void> {
		errorMessage = '';
		if (uploadMode) {
			if (!uploadID) {
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
		// Capture what we are about to parse: the picker stays reachable during the
		// await, so reading the state again afterwards would act on a file the user
		// picked meanwhile instead of the one this import consumed.
		const parsingUpload = uploadMode;
		const parsing = parsingUpload ? uploadID : filePath;
		const operation = operations.start($t('import.importing'));
		const ownsForm = (): boolean => operations.owns(operation);
		if (parsingUpload) uploader.consume(parsing);
		try {
			const parsed = parsingUpload ? await parseUpload(parsing) : await parseFile(parsing);
			if (ownsForm()) parsedData = parsed;
		} catch (e) {
			if (ownsForm()) errorMessage = translateError(e);
		} finally {
			const owned = ownsForm();
			operations.finish(operation);
			if (owned && parsingUpload) {
				uploadID = '';
				uploadFileName = '';
			}
			// A transport failure can happen before the backend consumes the upload.
			// Abort is harmless when parsing already removed it.
			if (parsingUpload) uploader.finishConsume(parsing);
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
		operations.invalidate();
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
					<Input bind:value={filePath} label={effectiveFilePathLabel} position={[0, 1]} onchange={() => operations.invalidate()} flex />
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
	{#if busyLabel}
		<Dialog title={$t('common.import')}>
			<div class="loading">
				<Spinner size="8vh" />
				<div class="loading-label">{busyLabel}</div>
			</div>
		</Dialog>
	{/if}
{/if}
