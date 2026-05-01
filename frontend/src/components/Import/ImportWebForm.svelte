<script lang="ts" generics="TData">
	import { type Snippet } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { createSubPage } from '../../scripts/subPage.svelte.ts';
	import { normalizePath } from '../../scripts/utils.ts';
	import Alert from '../Alert/Alert.svelte';
	import ButtonBar from '../Buttons/ButtonBar.svelte';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
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
		parseURL: (url: string) => Promise<TData>;
		urlLabel?: string | undefined;
		downloadPath?: string | undefined;
		downloadPathLabel?: string | undefined;
		validate?: (() => string | null) | undefined;
		confirm: Snippet<[ConfirmArgs]>;
		onConfirmDone: () => void;
	}

	let { areaID, position = LAYOUT.content, onBack, parseURL, urlLabel, downloadPath = $bindable(), downloadPathLabel, validate, confirm, onConfirmDone }: Props = $props();

	let url = $state('');
	let errorMessage = $state('');
	let parsedData = $state<TData | null>(null);
	let importing = $state(false);

	const showDownloadPath = $derived(downloadPath !== undefined);
	const effectiveURLLabel = $derived(urlLabel ?? $t('lish.import.url'));
	const effectiveDownloadPathLabel = $derived(downloadPathLabel ?? $t('lish.import.downloadPath'));

	async function handleImport(): Promise<void> {
		errorMessage = '';
		if (!url.trim()) {
			errorMessage = $t('common.errorURLRequired');
			return;
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
			parsedData = await parseURL(url);
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
	const downloadPathSubPage = createSubPage(navHandle, () => areaID);

	function openDownloadPathBrowse(): void {
		downloadPathSubPage.enter(effectiveDownloadPathLabel);
	}

	function handleDownloadPathSelect(path: string): void {
		downloadPath = normalizePath(path);
		void downloadPathSubPage.exit();
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
{:else if downloadPathSubPage.active && showDownloadPath}
	<FileBrowser {areaID} {position} initialPath={downloadPath ?? ''} directoriesOnly showPath selectDirectoryButton onSelect={handleDownloadPathSelect} onBack={handleDownloadPathBrowseBack} />
{:else}
	<div class="import">
		<div class="container">
			<div role="group" data-mouse-activate-area={areaID}>
				<Input bind:value={url} label={effectiveURLLabel} placeholder="https://..." position={[0, 0]} flex />
			</div>
			{#if showDownloadPath}
				<div class="row" role="group" data-mouse-activate-area={areaID}>
					<Input bind:value={downloadPath} label={effectiveDownloadPathLabel} position={[0, 1]} flex />
					<Button icon="/img/directory.svg" position={[1, 1]} onConfirm={openDownloadPathBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				</div>
			{/if}
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center" basePosition={[0, 2]}>
			<Button icon="/img/download.svg" label={$t('common.import')} onConfirm={handleImport} disabled={importing} />
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
