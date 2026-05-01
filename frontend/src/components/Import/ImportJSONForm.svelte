<script lang="ts" generics="TData">
	import { onMount, type Snippet } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { createSubPage } from '../../scripts/subPage.svelte.ts';
	import { isCompressed } from '@shared';
	import { normalizePath } from '../../scripts/utils.ts';
	import { api } from '../../scripts/api.ts';
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
		parseJSON: (content: string) => Promise<TData>;
		jsonLabel?: string | undefined;
		placeholder?: string | undefined;
		errorEmptyKey: string; // translation key shown when input is empty
		initialFilePath?: string | undefined;
		downloadPath?: string | undefined;
		downloadPathLabel?: string | undefined;
		validate?: (() => string | null) | undefined;
		confirm: Snippet<[ConfirmArgs]>;
		onConfirmDone: () => void;
	}

	let { areaID, position = LAYOUT.content, onBack, parseJSON, jsonLabel, placeholder, errorEmptyKey, initialFilePath = '', downloadPath = $bindable(), downloadPathLabel, validate, confirm, onConfirmDone }: Props = $props();

	let jsonText = $state('');
	let errorMessage = $state('');
	let parsedData = $state<TData | null>(null);
	let importing = $state(false);

	const showDownloadPath = $derived(downloadPath !== undefined);
	const effectiveDownloadPathLabel = $derived(downloadPathLabel ?? $t('lish.import.downloadPath'));

	async function handleImport(): Promise<void> {
		errorMessage = '';
		if (!jsonText.trim()) {
			errorMessage = $t(errorEmptyKey);
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
			parsedData = await parseJSON(jsonText);
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

	async function loadInitialFile(): Promise<void> {
		if (!initialFilePath) return;
		try {
			const compressed = isCompressed(initialFilePath);
			const content = compressed ? await api.fs.readCompressed(initialFilePath, 'gzip') : await api.fs.readText(initialFilePath);
			if (content) {
				// Pretty-print minified JSON for readability
				try {
					const parsed = JSON.parse(content);
					jsonText = JSON.stringify(parsed, null, '\t');
				} catch {
					jsonText = content;
				}
			}
		} catch {
			// Ignore error, user can still paste JSON manually
		}
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

	onMount(() => {
		void loadInitialFile();
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
				<Input bind:value={jsonText} label={jsonLabel} multiline rows={15} fontSize="2vh" fontFamily="var(--font-mono)" position={[0, 0]} placeholder={placeholder ?? ''} />
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
			<Button icon="/img/import.svg" label={$t('common.import')} onConfirm={handleImport} />
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
