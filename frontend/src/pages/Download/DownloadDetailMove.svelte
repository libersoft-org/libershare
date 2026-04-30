<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { normalizePath } from '../../scripts/utils.ts';
	import { api } from '../../scripts/api.ts';
	import { resetVerifyState, setMovingStatus } from '../../scripts/downloads.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { createSubPage } from '../../scripts/subPage.svelte.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	import DownloadDetailMoveProgress from './DownloadDetailMoveProgress.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		lish: { id: string; name: string; directory?: string | undefined };
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, lish, onBack }: Props = $props();
	let newDirectory = $state(untrack(() => lish.directory ?? ''));
	let moveData = $state(true);
	let createSubdirectory = $state(true);
	let errorMessage = $state('');
	const navHandle = createNavArea(() => ({ areaID, position, activate: true, onBack }));
	const browseSubPage = createSubPage(navHandle, areaID);
	const progressSubPage = createSubPage(navHandle, areaID);

	function openDirectoryBrowse(): void {
		browseSubPage.enter($t('common.newDirectory'));
	}

	function handleDirectorySelect(directoryPath: string): void {
		newDirectory = normalizePath(directoryPath);
		void browseSubPage.exit();
	}

	function handleMove(): void {
		errorMessage = '';
		if (!newDirectory.trim()) {
			errorMessage = $t('common.errorFilePathRequired');
			return;
		}
		openProgressPage();
	}

	function openProgressPage(): void {
		setMovingStatus(lish.id, true);
		progressSubPage.enter($t('downloads.moveProgress.title'), () => void handleProgressClose());
	}

	function handleMoveComplete(): void {
		// Start verification immediately after successful move
		resetVerifyState(lish.id);
		api.lishs.verify(lish.id).catch(err => console.error('Verification after move failed:', err));
	}

	async function handleProgressClose(): Promise<void> {
		await progressSubPage.exit();
		onBack?.();
	}
</script>

<style>
	.move {
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
	<FileBrowser {areaID} {position} initialPath={newDirectory || lish.directory || ''} showPath directoriesOnly selectDirectoryButton onSelect={handleDirectorySelect} onBack={() => void browseSubPage.exit()} />
{:else if progressSubPage.active}
	<DownloadDetailMoveProgress {areaID} {position} params={{ lishID: lish.id, newDirectory: newDirectory.trim(), moveData, createSubdirectory }} onBack={() => void handleProgressClose()} onComplete={handleMoveComplete} />
{:else}
	<div class="move">
		<div class="container">
			<div class="row">
				<Input bind:value={newDirectory} label={$t('common.newDirectory')} position={[0, 0]} flex />
				<Button icon="/img/directory.svg" position={[1, 0]} onConfirm={openDirectoryBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<SwitchRow label={$t('downloads.moveDataFromOriginal')} checked={moveData} position={[0, 1]} onToggle={() => (moveData = !moveData)} />
			<SwitchRow label={$t('downloads.createSubdirectory')} checked={createSubdirectory} position={[0, 2]} onToggle={() => (createSubdirectory = !createSubdirectory)} />
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center" basePosition={[0, 3]}>
			<Button icon="/img/move.svg" label={$t('downloads.move')} disabled={progressSubPage.active} onConfirm={handleMove} />
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
