<script lang="ts">
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { storageLISHnetPath } from '../../scripts/settings.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { api } from '../../scripts/api.ts';
	import { type LISHNetworkDefinition } from '@shared';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import ImportOverwrite from './SettingsLISHNetworkImportOverwrite.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack, onImport }: Props = $props();
	let removeBackHandler: (() => void) | null = null;
	let filePath = $state('');
	let errorMessage = $state('');
	let browsingFilePath = $state(false);
	let parsedNetworks = $state<LISHNetworkDefinition[] | null>(null);

	async function handleImport(): Promise<void> {
		errorMessage = '';
		if (!filePath.trim()) {
			errorMessage = $t('common.errorFilePathRequired');
			return;
		}
		try {
			parsedNetworks = await api.lishnets.parseFromFile(filePath);
		} catch (e) {
			errorMessage = translateError(e);
		}
	}

	function handleOverwriteDone(): void {
		parsedNetworks = null;
		onImport?.();
		onBack?.();
		onBack?.();
	}

	function openFilePathBrowse(): void {
		browsingFilePath = true;
		navHandle.pause();
		pushBreadcrumb($t('settings.lishNetworkImport.filePath'));
		removeBackHandler = pushBackHandler(handleBrowseBack);
	}

	function handleFilePathSelect(path: string): void {
		filePath = path;
		handleBrowseBack();
	}

	function handleBrowseBack(): void {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		browsingFilePath = false;
		navHandle.resume();
		activateArea(areaID);
	}

	const navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));
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

{#if parsedNetworks}
	<ImportOverwrite networks={parsedNetworks} {position} onDone={handleOverwriteDone} />
{:else if browsingFilePath}
	<FileBrowser {areaID} {position} initialPath={filePath || $storageLISHnetPath} showPath fileFilter={['*.lishnet', '*.lishnets', '*.json', '*.lishnet.gz', '*.lishnets.gz', '*.json.gz', '*.lishnet.gzip', '*.lishnets.gzip', '*.json.gzip']} fileFilterName={'LISHNET ' + $t('common.extensions')} selectFileButton onSelect={handleFilePathSelect} onBack={handleBrowseBack} />
{:else}
	<div class="import">
		<div class="container">
			<div class="row">
				<Input bind:value={filePath} label={$t('settings.lishNetworkImport.filePath')} position={[0, 0]} flex />
				<Button icon="/img/directory.svg" position={[1, 0]} onConfirm={openFilePathBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center" basePosition={[0, 1]}>
			<Button icon="/img/download.svg" label={$t('common.import')} onConfirm={handleImport} />
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
