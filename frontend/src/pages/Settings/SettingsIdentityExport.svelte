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
	import { storageBackupPath } from '../../scripts/settings.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	let saving = $state(false);
	let browseDirectory = $state('');
	let errorMessage = $state('');
	let showOverwriteConfirm = $state(false);
	let peerID = $state('');

	function generateFileName(id: string): string {
		return id ? `identity_${id}.json` : 'identity.json';
	}

	let filePath = $state(joinPath($storageBackupPath, generateFileName('')));

	async function loadPeerID(): Promise<void> {
		try {
			const info = await api.identity.get();
			peerID = info.peerID;
			filePath = joinPath($storageBackupPath, generateFileName(peerID));
		} catch {
			// Keep default name; user can rename it
		}
	}

	void loadPeerID();

	const navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));
	const browseSubPage = createSubPage(navHandle, areaID);

	function openDirectoryBrowse(): void {
		const { directory } = splitPath(filePath.trim(), $storageBackupPath);
		browseDirectory = directory;
		browseSubPage.enter($t('common.openDirectory'));
	}

	function handleDirectorySelect(directoryPath: string): void {
		const { fileName } = splitPath(filePath.trim(), $storageBackupPath);
		filePath = joinPath(directoryPath, fileName || generateFileName(peerID));
		void browseSubPage.exit();
	}

	async function handleSave(): Promise<void> {
		errorMessage = '';
		if (!filePath.trim()) {
			errorMessage = $t('common.errorFilePathRequired');
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
		saving = true;
		errorMessage = '';
		try {
			const result = await api.identity.exportToFile(filePath.trim());
			if (result.success) {
				addNotification(tt('settings.identity.exported'), 'success');
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
		void doSave();
	}

	async function cancelOverwrite(): Promise<void> {
		showOverwriteConfirm = false;
		await tick();
		activateArea(areaID);
	}
</script>

<style>
	.export-id {
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
	<div class="export-id">
		<div class="container">
			<div class="row">
				<Input bind:value={filePath} label={$t('common.file')} position={[0, 0]} flex />
				<Button icon="/img/directory.svg" position={[1, 0]} onConfirm={openDirectoryBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center" basePosition={[0, 1]}>
			<Button icon="/img/save.svg" label={$t('common.save')} disabled={saving} onConfirm={handleSave} />
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
{#if showOverwriteConfirm}
	<ConfirmDialog title={$t('common.overwriteFile')} message={$t('common.errorFileExistsOverwrite', { name: filePath })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmOverwrite} onBack={cancelOverwrite} />
{/if}
