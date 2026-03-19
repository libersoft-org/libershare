<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { t, translateError, tt } from '../../scripts/language.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { normalizePath } from '../../scripts/utils.ts';
	import { api } from '../../scripts/api.ts';
	import { resetVerifyState, setMovingStatus } from '../../scripts/downloads.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		lish: { id: string; name: string; directory?: string | undefined };
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, lish, onBack }: Props = $props();
	let removeBackHandler: (() => void) | null = null;
	let browsingDirectory = $state(false);
	let newDirectory = $state(untrack(() => lish.directory ?? ''));
	let moveData = $state(true);
	let createSubdirectory = $state(true);
	let moving = $state(false);
	let errorMessage = $state('');

	const navHandle = createNavArea(() => ({ areaID, position, activate: true, onBack }));

	function openDirectoryBrowse(): void {
		browsingDirectory = true;
		navHandle.pause();
		pushBreadcrumb($t('downloads.newDirectory'));
		removeBackHandler = pushBackHandler(handleBrowseBack);
	}

	function handleDirectorySelect(directoryPath: string): void {
		newDirectory = normalizePath(directoryPath);
		handleBrowseBack();
	}

	async function handleBrowseBack(): Promise<void> {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		browsingDirectory = false;
		await tick();
		navHandle.resume();
		activateArea(areaID);
	}

	async function handleMove(): Promise<void> {
		errorMessage = '';
		if (!newDirectory.trim()) {
			errorMessage = $t('common.errorFilePathRequired');
			return;
		}
		moving = true;
		setMovingStatus(lish.id, true);
		try {
			const result = await api.lishs.move(lish.id, newDirectory.trim(), moveData, createSubdirectory);
			if (result.success) {
				addNotification(tt('downloads.moveSuccess', { name: lish.name || lish.id }));
				// Trigger verification after successful move
				resetVerifyState(lish.id);
				api.lishs.verify(lish.id).catch(err => console.error('Verification after move failed:', err));
				onBack?.();
				return;
			}
			errorMessage = $t('downloads.moveFailed');
		} catch (e: any) {
			errorMessage = translateError(e);
		} finally {
			moving = false;
			setMovingStatus(lish.id, false);
		}
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

{#if browsingDirectory}
	<FileBrowser {areaID} {position} initialPath={newDirectory || lish.directory || ''} showPath directoriesOnly selectDirectoryButton onSelect={handleDirectorySelect} onBack={handleBrowseBack} />
{:else}
	<div class="move">
		<div class="container">
			<div class="row">
				<Input bind:value={newDirectory} label={$t('downloads.newDirectory')} position={[0, 0]} flex />
				<Button icon="/img/directory.svg" position={[1, 0]} onConfirm={openDirectoryBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<SwitchRow label={$t('downloads.moveDataFromOriginal')} checked={moveData} position={[0, 1]} onToggle={() => (moveData = !moveData)} />
			<SwitchRow label={$t('downloads.createSubdirectory')} checked={createSubdirectory} position={[0, 2]} onToggle={() => (createSubdirectory = !createSubdirectory)} />
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center">
			<Button icon="/img/move.svg" label={$t('downloads.move')} disabled={moving} position={[0, 3]} onConfirm={handleMove} />
			<Button icon="/img/back.svg" label={$t('common.back')} position={[1, 3]} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
