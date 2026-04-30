<script lang="ts">
	import { tick } from 'svelte';
	import { t, translateError, tt } from '../../scripts/language.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { createSubPage } from '../../scripts/subPage.svelte.ts';
	import { splitPath, joinPath } from '../../scripts/fileBrowser.ts';
	import { api } from '../../scripts/api.ts';
	import { storageLISHnetPath, defaultMinifyJSON, defaultCompress } from '../../scripts/settings.ts';
	import { sanitizeFilename } from '@shared';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		network?: { id: string; name: string } | null | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, network = null, onBack }: Props = $props();
	let browseDirectory = $state('');
	let saving = $state(false);
	let minifyJSONState = $state($defaultMinifyJSON);
	let compress = $state($defaultCompress);
	let errorMessage = $state('');
	let showOverwriteConfirm = $state(false);

	function getInitialFileName(): string {
		const baseName = network ? sanitizeFilename(network.name || network.id) : 'network';
		return `${baseName}.lishnet`;
	}

	const initialFileName = getInitialFileName();
	let filePath = $state(joinPath($storageLISHnetPath, $defaultCompress ? initialFileName + '.gz' : initialFileName));

	function updateFileExtension(): void {
		if (filePath.endsWith('.lishnet') || filePath.endsWith('.lishnet.gz')) {
			if (compress && filePath.endsWith('.lishnet')) filePath = filePath + '.gz';
			else if (!compress && filePath.endsWith('.lishnet.gz')) filePath = filePath.slice(0, -3);
		}
	}

	function handleCompressToggle(): void {
		compress = !compress;
		updateFileExtension();
	}

	const navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));
	const browseSubPage = createSubPage(navHandle, () => areaID);

	function openDirectoryBrowse(): void {
		const { directory } = splitPath(filePath.trim(), $storageLISHnetPath);
		browseDirectory = directory;
		browseSubPage.enter($t('common.openDirectory'));
	}

	function handleDirectorySelect(directoryPath: string): void {
		const { fileName } = splitPath(filePath.trim(), $storageLISHnetPath);
		filePath = joinPath(directoryPath, fileName || getInitialFileName());
		void browseSubPage.exit();
	}

	async function handleSave(): Promise<void> {
		errorMessage = '';
		if (!filePath.trim()) {
			errorMessage = $t('common.errorFilePathRequired');
			return;
		}
		if (!network) {
			errorMessage = $t('settings.lishNetwork.errorNetworkIDRequired');
			return;
		}
		const check = await api.fs.exists(filePath.trim());
		if (check.exists) {
			showOverwriteConfirm = true;
			return;
		}
		await doSave();
	}

	async function doSave(): Promise<void> {
		if (!network) return;
		saving = true;
		errorMessage = '';
		try {
			const result = await api.lishnets.exportToFile(network.id, filePath.trim(), minifyJSONState, compress);
			if (result.success) {
				addNotification(tt('settings.lishNetwork.networkExported', { name: network.name || network.id }), 'success');
				onBack?.();
				return;
			} else errorMessage = 'Save failed';
		} catch (e: any) {
			errorMessage = translateError(e);
		} finally {
			saving = false;
		}
	}

	function confirmOverwrite(): void {
		showOverwriteConfirm = false;
		doSave();
	}

	async function cancelOverwrite(): Promise<void> {
		showOverwriteConfirm = false;
		await tick();
		activateArea(areaID);
	}
</script>

<style>
	.export {
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

{#if browseSubPage.active}
	<FileBrowser {areaID} {position} initialPath={browseDirectory} showPath directoriesOnly selectDirectoryButton onSelect={handleDirectorySelect} onBack={() => void browseSubPage.exit()} />
{:else}
	<div class="export">
		<div class="container">
			<div class="row">
				<Input bind:value={filePath} label={$t('common.file')} position={[0, 0]} flex />
				<Button icon="/img/directory.svg" position={[1, 0]} onConfirm={openDirectoryBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<SwitchRow label={$t('settings.lishNetwork.minifyJSON')} checked={minifyJSONState} position={[0, 1]} onToggle={() => (minifyJSONState = !minifyJSONState)} />
			<SwitchRow label={$t('settings.lishNetwork.compress')} checked={compress} position={[0, 2]} onToggle={handleCompressToggle} />
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center" basePosition={[0, 3]}>
			<Button icon="/img/save.svg" label={$t('common.save')} disabled={saving} onConfirm={handleSave} />
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
{#if showOverwriteConfirm}
	<ConfirmDialog title={$t('common.overwriteFile')} message={$t('common.errorFileExistsOverwrite', { name: filePath })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmOverwrite} onBack={cancelOverwrite} />
{/if}
