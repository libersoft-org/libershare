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
	/**
	 * Id of the last transfer this form started, whether it finished or not, and
	 * only ever used to clean up. `uploadID` is the one that may be imported, so it
	 * stays empty until the upload succeeded — which used to mean a transfer that
	 * failed halfway left nothing here to discard.
	 */
	let startedUploadID = '';
	let fileInput = $state<HTMLInputElement>();
	let errorMessage = $state('');
	let parsedData = $state<TData | null>(null);
	/** Label shown in the blocking dialog, empty while nothing is running. */
	let busyLabel = $state('');
	/** Set once the form is gone, so an upload that finishes later cleans up after itself. */
	let destroyed = false;

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
		// Picking a second file abandons the first one on the backend's disk —
		// whether that one finished or died in the middle.
		const previous = startedUploadID;
		uploadID = '';
		uploadFileName = file.name;
		errorMessage = '';
		busyLabel = $t('import.uploading');
		try {
			// Awaited, and the error is not swallowed. The next transfer starts on this
			// same socket immediately afterwards, and the old file has to be off the
			// disk and out of the quota before the new one begins claiming both — so a
			// cleanup that did not happen is this pick's problem, not a footnote.
			if (previous) {
				await api.upload.abort(previous);
				startedUploadID = '';
			}
			// The file goes to the backend as-is and is parsed there. Reading it here
			// would also mean decompressing it here, and the browser only knows gzip
			// and deflate — a .br or .zst upload has no chance.
			const id = await uploadImportFile(file, started => (startedUploadID = started));
			// The form can be closed mid-upload; the file that lands afterwards has
			// nobody left to import or discard it, so drop it here instead.
			if (destroyed) void api.upload.abort(id).catch(() => {});
			else uploadID = id;
		} catch (err) {
			errorMessage = translateError(err);
			uploadFileName = '';
		} finally {
			busyLabel = '';
		}
	}

	function toggleUploadMode(): void {
		uploadMode = !uploadMode;
	}

	// Leaving the form after picking a file but before importing it — Back, a
	// mode switch followed by a path import, any navigation away — would strand
	// the uploaded copy on the backend's disk until it ages out.
	onDestroy(() => {
		destroyed = true;
		if (startedUploadID) void api.upload.abort(startedUploadID).catch(() => {});
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
		try {
			busyLabel = $t('import.importing');
			// The backend consumes the upload as part of parsing it — reading the
			// file and deleting it under its own lock — so there is nothing left to
			// clean up here on either outcome.
			parsedData = uploadMode ? await parseUpload(uploadID) : await parseFile(filePath);
			if (uploadMode) {
				uploadID = '';
				startedUploadID = '';
				uploadFileName = '';
			}
		} catch (e) {
			errorMessage = translateError(e);
			// A failed parse consumes the upload too, so the picked file has to be
			// chosen again rather than silently retried against a file that is gone.
			if (uploadMode) {
				uploadID = '';
				startedUploadID = '';
				uploadFileName = '';
			}
		} finally {
			busyLabel = '';
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
	{#if busyLabel}
		<Dialog title={$t('common.import')}>
			<div class="loading">
				<Spinner size="8vh" />
				<div class="loading-label">{busyLabel}</div>
			</div>
		</Dialog>
	{/if}
{/if}
