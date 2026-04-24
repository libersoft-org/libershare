<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb, navigateBack } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { storagePath, autoStartSharing, autoStartDownloading } from '../../scripts/settings.ts';
	import { normalizePath } from '../../scripts/utils.ts';
	import { isCompressed } from '@shared';
	import { type ILISH } from '@shared';
	import { api } from '../../scripts/api.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import ImportOverwrite from './DownloadLISHImportOverwrite.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		initialFilePath?: string | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = CONTENT_POSITIONS.main, initialFilePath = '', onBack, onImport }: Props = $props();
	let removeBackHandler: (() => void) | null = null;
	let lishJSON = $state('');
	let downloadPath = $state($storagePath);
	let errorMessage = $state('');
	let browsingDownloadPath = $state(false);
	let parsedLISHs = $state<ILISH[] | null>(null);

	async function handleImport(): Promise<void> {
		errorMessage = '';
		if (!lishJSON.trim()) {
			errorMessage = $t('lish.import.jsonRequired');
			return;
		}
		if (!downloadPath.trim()) {
			errorMessage = $t('lish.import.downloadPathRequired');
			return;
		}
		try {
			parsedLISHs = await api.lishs.parseFromJSON(lishJSON);
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

	function openDownloadPathBrowse(): void {
		browsingDownloadPath = true;
		navHandle.pause();
		pushBreadcrumb($t('lish.import.downloadPath'));
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
		navHandle.resume();
		activateArea(areaID);
	}

	async function loadInitialFile(): Promise<void> {
		if (initialFilePath) {
			try {
				const compressed = isCompressed(initialFilePath);
				const content = compressed ? await api.fs.readCompressed(initialFilePath, 'gzip') : await api.fs.readText(initialFilePath);
				if (content) {
					// Pretty-print minified JSON for readability
					try {
						const parsed = JSON.parse(content);
						lishJSON = JSON.stringify(parsed, null, '\t');
					} catch {
						lishJSON = content;
					}
				}
			} catch (e) {
				// Ignore error, user can still paste JSON manually
			}
		}
	}

	onMount(() => {
		loadInitialFile();
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

{#if parsedLISHs}
	<ImportOverwrite lishs={parsedLISHs} {downloadPath} {position} enableSharing={$autoStartSharing} enableDownloading={$autoStartDownloading} onDone={handleOverwriteDone} />
{:else if browsingDownloadPath}
	<FileBrowser {areaID} {position} initialPath={downloadPath} directoriesOnly showPath selectDirectoryButton onSelect={handleBrowseSelect} onBack={handleBrowseBack} />
{:else}
	<div class="import">
		<div class="container">
			<Input bind:value={lishJSON} label={$t('lish.import.lishJSON')} multiline rows={10} placeholder={$t('lish.import.placeholder')} fontSize="2vh" fontFamily="var(--font-mono)" position={[0, 0]} />
			<div class="row">
				<Input bind:value={downloadPath} label={$t('lish.import.downloadPath')} position={[0, 1]} flex />
				<Button icon="/img/directory.svg" position={[1, 1]} onConfirm={openDownloadPathBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center">
			<Button icon="/img/download.svg" label={$t('common.import')} position={[0, 2]} onConfirm={handleImport} />
			<Button icon="/img/back.svg" label={$t('common.back')} position={[1, 2]} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
