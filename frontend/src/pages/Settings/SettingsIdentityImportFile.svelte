<script lang="ts">
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { storageBackupPath } from '../../scripts/settings.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { createSubPage } from '../../scripts/subPage.svelte.ts';
	import { api } from '../../scripts/api.ts';
	import { type IdentityBackup } from '@shared';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import SettingsIdentityImportConfirm from './SettingsIdentityImportConfirm.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack, onImport }: Props = $props();
	let filePath = $state('');
	let errorMessage = $state('');
	let parsedData = $state<IdentityBackup | null>(null);
	let currentPeerID = $state('');

	async function handleImport(): Promise<void> {
		errorMessage = '';
		if (!filePath.trim()) {
			errorMessage = $t('common.errorFilePathRequired');
			return;
		}
		try {
			const current = await api.identity.get();
			currentPeerID = current.peerID;
			parsedData = await api.identity.parseFromFile(filePath);
		} catch (e) {
			errorMessage = translateError(e);
		}
	}

	function handleConfirmDone(): void {
		parsedData = null;
		onImport?.();
		onBack?.();
		onBack?.();
	}

	const navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));
	const browseSubPage = createSubPage(navHandle, areaID);

	function openFilePathBrowse(): void {
		browseSubPage.enter($t('common.fromFile'));
	}

	function handleFilePathSelect(path: string): void {
		filePath = path;
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

{#if parsedData}
	<SettingsIdentityImportConfirm data={parsedData} {currentPeerID} {position} onDone={handleConfirmDone} />
{:else if browseSubPage.active}
	<FileBrowser {areaID} {position} initialPath={filePath || $storageBackupPath} showPath fileFilter={['*.json']} fileFilterName={'JSON ' + $t('common.extensions')} selectFileButton onSelect={handleFilePathSelect} onBack={() => void browseSubPage.exit()} />
{:else}
	<div class="import">
		<div class="container">
			<div class="row">
				<Input bind:value={filePath} label={$t('common.file')} position={[0, 0]} flex />
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
