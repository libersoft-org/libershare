<script lang="ts">
	import { tick } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb, navigateBack } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { storagePath, autoStartSharing, autoStartDownloading } from '../../scripts/settings.ts';
	import { normalizePath } from '../../scripts/utils.ts';
	import { api } from '../../scripts/api.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { localFilesystem } from '../../scripts/localFilesystem.ts';
	import { type ILISH } from '@shared';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	import ImportOverwrite from './DownloadLISHImportOverwrite.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = CONTENT_POSITIONS.main, onBack, onImport }: Props = $props();
	let removeBackHandler: (() => void) | null = null;
	let filePath = $state('');
	let uploadMode = $state(!$localFilesystem);
	let uploadFileName = $state('');
	let uploadContent = $state('');
	let fileInput: HTMLInputElement;
	let downloadPath = $state($storagePath);
	let autoStart = $state($autoStartSharing);
	let autoStartDl = $state($autoStartDownloading);
	let errorMessage = $state('');
	let browsingFilePath = $state(false);
	let browsingDownloadPath = $state(false);
	let parsedLISHs = $state<ILISH[] | null>(null);

	function openFilePicker(): void { fileInput?.click(); }

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

	async function handleImport(): Promise<void> {
		errorMessage = '';
		if (uploadMode) {
			if (!uploadContent.trim()) {
				errorMessage = $t('lish.import.uploadRequired');
				return;
			}
		} else {
			if (!filePath.trim()) {
				errorMessage = $t('common.errorFilePathRequired');
				return;
			}
		}
		if (!downloadPath.trim()) {
			errorMessage = $t('lish.import.downloadPathRequired');
			return;
		}
		try {
			parsedLISHs = uploadMode
				? await api.lishs.parseFromJSON(uploadContent)
				: await api.lishs.parseFromFile(filePath);
		} catch (e) {
			errorMessage = translateError(e);
		}
	}

	function handleOverwriteDone(): void {
		parsedLISHs = null;
		if (onImport) onImport();
		else {
			navigateBack();
			navigateBack();
		}
	}

	const navHandle = createNavArea(() => ({ areaID, position, activate: true, onBack }));

	function openFilePathBrowse(): void {
		browsingFilePath = true;
		navHandle.pause();
		pushBreadcrumb($t('lish.import.filePath'));
		removeBackHandler = pushBackHandler(handleBrowseBack);
	}

	function openDownloadPathBrowse(): void {
		browsingDownloadPath = true;
		navHandle.pause();
		pushBreadcrumb($t('lish.import.downloadPath'));
		removeBackHandler = pushBackHandler(handleBrowseBack);
	}

	function handleFilePathSelect(path: string): void {
		filePath = path;
		handleBrowseBack();
	}

	function handleDownloadPathSelect(path: string): void {
		downloadPath = normalizePath(path);
		handleBrowseBack();
	}

	async function handleBrowseBack(): Promise<void> {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		browsingFilePath = false;
		browsingDownloadPath = false;
		await tick();
		navHandle.resume();
		activateArea(areaID);
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
</style>

{#if parsedLISHs}
	<ImportOverwrite lishs={parsedLISHs} {downloadPath} {position} enableSharing={autoStart} enableDownloading={autoStartDl} onDone={handleOverwriteDone} />
{:else if browsingFilePath}
	<FileBrowser {areaID} {position} initialPath={filePath || $storagePath} showPath fileFilter={['*.lish', '*.lishs', '*.json', '*.lish.gz', '*.lishs.gz', '*.json.gz', '*.lish.gzip', '*.lishs.gzip', '*.json.gzip']} fileFilterName={'LISH ' + $t('common.extensions')} selectFileButton onSelect={handleFilePathSelect} onBack={handleBrowseBack} />
{:else if browsingDownloadPath}
	<FileBrowser {areaID} {position} initialPath={downloadPath} directoriesOnly showPath selectDirectoryButton onSelect={handleDownloadPathSelect} onBack={handleBrowseBack} />
{:else}
	<input class="file-input" type="file" accept=".lish,.lishs,.json,.lish.gz,.lishs.gz,.json.gz,.lish.gzip,.lishs.gzip,.json.gzip" bind:this={fileInput} onchange={handleFileSelected} />
	<div class="import">
		<div class="container">
			{#if !$localFilesystem}
				<SwitchRow label={$t('lish.import.uploadFromLocal')} checked={uploadMode} position={[0, 0]} onToggle={() => (uploadMode = !uploadMode)} />
			{/if}
			{#if uploadMode}
				<div class="row">
					<Input value={uploadFileName || $t('lish.import.noFileSelected')} label={$t('lish.import.localFile')} position={[0, 1]} flex disabled />
					<Button icon="/img/upload.svg" position={[1, 1]} onConfirm={openFilePicker} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				</div>
			{:else}
				<div class="row">
					<Input bind:value={filePath} label={$t('lish.import.filePath')} position={[0, 1]} flex />
					<Button icon="/img/directory.svg" position={[1, 1]} onConfirm={openFilePathBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				</div>
			{/if}
			<div class="row">
				<Input bind:value={downloadPath} label={$t('lish.import.downloadPath')} position={[0, 2]} flex />
				<Button icon="/img/directory.svg" position={[1, 2]} onConfirm={openDownloadPathBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<SwitchRow label={$t('lish.import.autoStartSharing')} checked={autoStart} position={[0, 3]} onToggle={() => (autoStart = !autoStart)} />
			<SwitchRow label={$t('lish.import.autoStartDownloading')} checked={autoStartDl} position={[0, 4]} onToggle={() => (autoStartDl = !autoStartDl)} />
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center">
			<Button icon="/img/download.svg" label={$t('common.import')} position={[0, 5]} onConfirm={handleImport} />
			<Button icon="/img/back.svg" label={$t('common.back')} position={[1, 5]} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
