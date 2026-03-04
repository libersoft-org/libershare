<script lang="ts">
	import { tick } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { sanitizeFilename } from '@shared';
	import { SUPPORTED_ALGOS, DEFAULT_ALGO, type HashAlgorithm, parseBytes } from '@shared';
	import { storageLISHPath, storagePath, autoStartSharing, defaultMinifyJSON, defaultCompress } from '../../scripts/settings.ts';

	function parseChunkSize(value: string): number | null {
		if (!value.trim()) return null;
		try {
			const bytes = parseBytes(value);
			return bytes > 0 ? bytes : null;
		} catch {
			return null;
		}
	}

	interface LISHCreateFormData {
		dataPath: string;
		saveToFile?: boolean | undefined;
		lishFile?: string | undefined;
		addToSharing?: boolean | undefined;
		chunkSize?: string | undefined;
		threads?: string | undefined;
	}

	type LISHCreateError = 'INPUT_REQUIRED' | 'LISH_FILE_REQUIRED' | 'INVALID_CHUNK_SIZE' | 'INVALID_THREADS' | null;

	function validateLISHCreateForm(data: LISHCreateFormData): LISHCreateError {
		if (!data.dataPath.trim()) return 'INPUT_REQUIRED';
		if (data.saveToFile && !data.lishFile?.trim()) return 'LISH_FILE_REQUIRED';
		if (data.chunkSize) {
			const parsed = parseChunkSize(data.chunkSize);
			if (parsed === null) return 'INVALID_CHUNK_SIZE';
		}
		if (data.threads) {
			const num = parseInt(data.threads);
			if (isNaN(num) || num < 0) return 'INVALID_THREADS';
		}
		return null;
	}

	function getLISHCreateErrorMessage(errorCode: LISHCreateError, t: (key: string) => string): string {
		switch (errorCode) {
			case 'INPUT_REQUIRED':
				return t('downloads.lishCreate.dataPathRequired');
			case 'LISH_FILE_REQUIRED':
				return t('downloads.lishCreate.lishFileRequired');
			case 'INVALID_CHUNK_SIZE':
				return t('downloads.lishCreate.invalidChunkSize');
			case 'INVALID_THREADS':
				return t('downloads.lishCreate.invalidThreads');
			default:
				return '';
		}
	}
	import { splitPath, joinPath } from '../../scripts/fileBrowser.ts';
	import { api } from '../../scripts/api.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	import DownloadLISHProgress from './DownloadLISHProgress.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = CONTENT_POSITIONS.main, onBack }: Props = $props();
	let removeBackHandler: (() => void) | null = null;
	// Browse state
	let browsingInputPath = $state(false);
	let browsingLISHFile = $state(false);
	let creating = $state(false);
	let showOverwriteConfirm = $state(false);
	let pendingCreateParams = $state<Record<string, any>>({});
	let createParams = $state<Record<string, any>>({});
	let browseFolder = $state('');
	let browseFile = $state<string | undefined>(undefined);
	let lishFileName = $state(''); // File name input in LISH file browse dialog
	// Form state
	let dataPath = $state($storagePath);
	let saveToFile = $state(true);
	let addToSharing = $state($autoStartSharing);
	let minifyJSON = $state($defaultMinifyJSON);
	let compress = $state($defaultCompress);
	let showAdvanced = $state(false);
	let name = $state('');
	// LISH file path - editable state, initialized from settings
	let lishFile = $state($storageLISHPath);
	let lishFileManuallyEdited = $state(false); // Track if user manually edited the path

	function handleNameChange(newName: string): void {
		name = newName;
		if (!lishFileManuallyEdited) {
			const sanitized = newName ? sanitizeFilename(newName) : '';
			if (sanitized) {
				const { folder } = splitPath(lishFile || $storageLISHPath, $storageLISHPath);
				lishFile = joinPath(folder, sanitized + (compress ? '.lish.gz' : '.lish'));
			} else {
				const { folder } = splitPath(lishFile || $storageLISHPath, $storageLISHPath);
				lishFile = folder;
			}
		}
	}

	function handleCompressToggle(): void {
		compress = !compress;
		if (lishFile.endsWith('.lish') || lishFile.endsWith('.lish.gz')) {
			if (compress && lishFile.endsWith('.lish')) lishFile = lishFile + '.gz';
			else if (!compress && lishFile.endsWith('.lish.gz')) lishFile = lishFile.slice(0, -3);
		}
	}

	let description = $state('');
	let chunkSize = $state('1M'); // Default 1MB
	let algorithm = $state<HashAlgorithm>(DEFAULT_ALGO);
	let threads = $state('0');
	// Validation error - only set on submit
	let errorMessage = $state('');

	async function handleCreate(): Promise<void> {
		const validationError = validateLISHCreateForm({ dataPath, saveToFile, lishFile: saveToFile ? lishFile || undefined : undefined, addToSharing, chunkSize, threads });
		errorMessage = validationError ? getLISHCreateErrorMessage(validationError, $t) : '';
		if (!errorMessage) {
			// Check if data path exists and is not an empty directory
			try {
				const pathCheck = await api.fs.exists(dataPath);
				if (!pathCheck.exists) {
					errorMessage = $t('downloads.lishCreate.dataPathNotFound');
					return;
				}
				if (pathCheck.type === 'directory') {
					const listing = await api.fs.list(dataPath);
					if (listing.entries.length === 0) {
						errorMessage = $t('downloads.lishCreate.emptyDirectory');
						return;
					}
				}
			} catch {
				// If checks fail, let the backend handle it
			}
			const params: Record<string, any> = {
				dataPath,
			};
			if (name) params['name'] = name;
			if (description) params['description'] = description;
			if (saveToFile && lishFile) params['lishFile'] = lishFile;
			if (saveToFile) {
				params['minifyJSON'] = minifyJSON;
				params['compress'] = compress;
			}
			if (addToSharing) params['addToSharing'] = addToSharing;
			// Only pass non-default advanced options
			const parsedChunkSize = parseChunkSize(chunkSize);
			if (parsedChunkSize !== null && parsedChunkSize !== 1024 * 1024) params['chunkSize'] = parsedChunkSize;
			if (algorithm !== DEFAULT_ALGO) params['algorithm'] = algorithm;
			const parsedThreads = parseInt(threads) || 0;
			if (parsedThreads !== 0) params['threads'] = parsedThreads;
			// Check if LISH file already exists (skip if it's a directory - backend will auto-name the file)
			if (saveToFile && lishFile) {
				try {
					const result = await api.fs.exists(lishFile);
					if (result.exists && result.type === 'file') {
						pendingCreateParams = params;
						showOverwriteConfirm = true;
						return;
					}
				} catch (e) {
					// If check fails, proceed anyway
				}
			}
			openProgressPage(params);
		}
	}

	function confirmOverwrite(): void {
		showOverwriteConfirm = false;
		openProgressPage(pendingCreateParams);
	}

	async function cancelOverwrite(): Promise<void> {
		showOverwriteConfirm = false;
		await tick();
		activateArea(areaID);
	}

	const navHandle = createNavArea(() => ({ areaID, position, activate: true, onBack }));

	function openProgressPage(params: Record<string, any>): void {
		createParams = params;
		creating = true;
		navHandle.pause();
		pushBreadcrumb($t('downloads.lishCreate.progress.title'));
		removeBackHandler = pushBackHandler(handleProgressBack);
	}

	async function handleProgressBack(): Promise<void> {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		creating = false;
		await tick();
		navHandle.resume();
		activateArea(areaID);
	}

	function handleProgressDone(): void {
		// Clean up without re-registering area (we're navigating away)
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		creating = false;
		onBack?.();
	}

	function openInputPathBrowse(): void {
		const { folder, fileName } = splitPath(dataPath.trim(), $storagePath);
		browseFolder = folder;
		browseFile = fileName;
		browsingInputPath = true;
		navHandle.pause();
		pushBreadcrumb($t('downloads.lishCreate.dataPath'));
		removeBackHandler = pushBackHandler(handleBrowseBack);
	}

	function handleInputPathSelect(path: string): void {
		dataPath = path;
		handleBrowseBack();
	}

	function openOutputPathBrowse(): void {
		const { folder, fileName } = splitPath(lishFile.trim() || $storageLISHPath, $storageLISHPath);
		browseFolder = folder;
		lishFileName = fileName || '';
		browsingLISHFile = true;
		navHandle.pause();
		pushBreadcrumb($t('downloads.lishCreate.lishFile'));
		removeBackHandler = pushBackHandler(handleOutputBrowseBack);
	}

	function handleOutputPathSelect(folderPath: string): void {
		const fileName = lishFileName.trim() || 'output.lish';
		lishFile = joinPath(folderPath, fileName);
		lishFileManuallyEdited = true;
		handleOutputBrowseBack();
	}

	async function handleOutputBrowseBack(): Promise<void> {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		browsingLISHFile = false;
		await tick();
		navHandle.resume();
		activateArea(areaID);
	}

	async function handleBrowseBack(): Promise<void> {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		browsingInputPath = false;
		await tick();
		navHandle.resume();
		activateArea(areaID);
	}

</script>

<style>
	.create {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh;
		gap: 2vh;
		overflow-y: auto;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		width: 1000px;
		max-width: 100%;
	}

	.row {
		display: flex;
		gap: 1vh;
		align-items: flex-end;
	}

	.label {
		font-size: 2vh;
		color: var(--disabled-foreground);
		margin-top: 1vh;
	}

	.algo-selector {
		display: flex;
		flex-wrap: wrap;
		gap: 1vh;
	}
</style>

{#if browsingInputPath}
	<FileBrowser {areaID} {position} initialPath={browseFolder} initialFile={browseFile} showPath selectFolderButton selectFileButton onSelect={handleInputPathSelect} onBack={handleBrowseBack} />
{:else if browsingLISHFile}
	<FileBrowser {areaID} {position} initialPath={browseFolder} showPath foldersOnly selectFolderButton saveFileName={lishFileName} onSaveFileNameChange={v => (lishFileName = v)} onSelect={handleOutputPathSelect} onBack={handleOutputBrowseBack} />
{:else if creating}
	<DownloadLISHProgress {areaID} {position} params={createParams} onBack={handleProgressBack} onDone={handleProgressDone} />
{:else}
	<div class="create">
		<div class="container">
			<!-- Name (optional) -->
			<Input value={name} onchange={handleNameChange} label={`${$t('common.name')} (${$t('common.optional')})`} position={[0, 0]} />
			<!-- Description (optional) -->
			<Input bind:value={description} label={`${$t('common.description')} (${$t('common.optional')})`} multiline rows={3} position={[0, 1]} />
			<!-- Data Path (required) -->
			<div class="row">
				<Input bind:value={dataPath} label={$t('downloads.lishCreate.dataPath')} position={[0, 2]} flex />
				<Button icon="/img/folder.svg" position={[1, 2]} onConfirm={openInputPathBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<!-- Save to File Switch -->
			<SwitchRow label={$t('downloads.lishCreate.saveToFile') + ':'} checked={saveToFile} position={[0, 3]} onConfirm={() => (saveToFile = !saveToFile)} />
			{#if saveToFile}
				<!-- LISH File Path (optional) -->
				<div class="row">
					<Input bind:value={lishFile} label={`${$t('downloads.lishCreate.lishFile')} (${$t('common.optional')})`} position={[0, 4]} flex onchange={() => (lishFileManuallyEdited = true)} />
					<Button icon="/img/folder.svg" position={[1, 4]} onConfirm={openOutputPathBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				</div>
			{/if}
			<!-- Add to Sharing Switch -->
			<SwitchRow label={$t('downloads.lishImport.autoStartSharing') + ':'} checked={addToSharing} position={[0, 5]} onConfirm={() => (addToSharing = !addToSharing)} />
			<!-- Advanced Settings Toggle -->
			<Button icon={showAdvanced ? '/img/up.svg' : '/img/down.svg'} label={$t(showAdvanced ? 'downloads.lishCreate.hideAdvanced' : 'downloads.lishCreate.showAdvanced')} position={[0, 6]} onConfirm={() => (showAdvanced = !showAdvanced)} padding="1vh 2vh" fontSize="2vh" borderRadius="1vh" />
			{#if showAdvanced}
				{#if saveToFile}
					<!-- Minify JSON Switch -->
					<SwitchRow label={$t('settings.lishNetwork.minifyJSON') + ':'} checked={minifyJSON} position={[0, 7]} onConfirm={() => (minifyJSON = !minifyJSON)} />
					<!-- Compress Switch -->
					<SwitchRow label={$t('settings.lishNetwork.compress') + ':'} checked={compress} position={[0, 8]} onConfirm={handleCompressToggle} />
				{/if}
				<!-- Chunk Size -->
				<Input bind:value={chunkSize} label={$t('downloads.lishCreate.chunkSize')} position={[0, 9]} />
				<!-- Hash Algorithm -->
				<div>
					<div class="label">{$t('downloads.lishCreate.algorithm')}:</div>
					<div class="algo-selector">
						{#each SUPPORTED_ALGOS as algo, i}
							<Button label={algo} position={[i, 10]} active={algorithm === algo} onConfirm={() => (algorithm = algo)} padding="1vh 2vh" fontSize="2vh" borderRadius="1vh" />
						{/each}
					</div>
				</div>
				<!-- Threads -->
				<Input bind:value={threads} label={$t('downloads.lishCreate.threads')} type="number" min={0} position={[0, 11]} />
			{/if}
			<Alert type="error" message={errorMessage} />
		</div>
		<ButtonBar justify="center">
			<Button icon="/img/plus.svg" label={$t('downloads.lishCreate.create')} position={[0, 12]} onConfirm={handleCreate} />
			<Button icon="/img/back.svg" label={$t('common.back')} position={[1, 12]} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
{#if showOverwriteConfirm}
	<ConfirmDialog title={$t('common.overwriteFile')} message={$t('common.fileExistsOverwrite', { name: lishFile })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmOverwrite} onBack={cancelOverwrite} />
{/if}
