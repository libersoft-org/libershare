<script lang="ts">
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { navigateBack } from '../../scripts/navigation.ts';
	import { storagePath, autoStartSharing, autoStartDownloading } from '../../scripts/settings.ts';
	import { normalizePath } from '../../scripts/utils.ts';
	import { api } from '../../scripts/api.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { createSubPage } from '../../scripts/subPage.svelte.ts';
	import { type ILISH } from '@shared';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import ImportOverwrite from './DownloadLISHImportOverwrite.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = CONTENT_POSITIONS.main, onBack, onImport }: Props = $props();
	let url = $state('');
	let downloadPath = $state($storagePath);
	let errorMessage = $state('');
	let loading = $state(false);
	let parsedLISHs = $state<ILISH[] | null>(null);

	async function handleImport(): Promise<void> {
		errorMessage = '';
		if (!url.trim()) {
			errorMessage = $t('common.errorURLRequired');
			return;
		}
		if (!downloadPath.trim()) {
			errorMessage = $t('lish.import.downloadPathRequired');
			return;
		}
		loading = true;
		try {
			parsedLISHs = await api.lishs.parseFromURL(url);
		} catch (e) {
			errorMessage = translateError(e);
		} finally {
			loading = false;
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
	const browseSubPage = createSubPage(navHandle, () => areaID);

	function openDownloadPathBrowse(): void {
		browseSubPage.enter($t('lish.import.downloadPath'));
	}

	function handleDownloadPathSelect(path: string): void {
		downloadPath = normalizePath(path);
		void browseSubPage.exit();
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
</style>

{#if parsedLISHs}
	<ImportOverwrite lishs={parsedLISHs} {downloadPath} {position} enableSharing={$autoStartSharing} enableDownloading={$autoStartDownloading} onDone={handleOverwriteDone} />
{:else if browseSubPage.active}
	<FileBrowser {areaID} {position} initialPath={downloadPath} directoriesOnly showPath selectDirectoryButton onSelect={handleDownloadPathSelect} onBack={() => void browseSubPage.exit()} />
{:else}
	<div class="import">
		<div class="container">
			<Input bind:value={url} label={$t('lish.import.url')} placeholder="https://..." position={[0, 0]} flex />
			<div class="row">
				<Input bind:value={downloadPath} label={$t('lish.import.downloadPath')} position={[0, 1]} flex />
				<Button icon="/img/directory.svg" position={[1, 1]} onConfirm={openDownloadPathBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center" basePosition={[0, 2]}>
			<Button icon="/img/download.svg" label={$t('common.import')} onConfirm={handleImport} disabled={loading} />
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
