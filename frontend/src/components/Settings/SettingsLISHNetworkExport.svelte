<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { exportNetworkToJson } from '../../scripts/lishNetwork.ts';
	import { storageLishnetPath } from '../../scripts/settings.ts';
	import { joinPath } from '../../scripts/fileBrowser.ts';
	import { api } from '../../scripts/api.ts';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	interface Props {
		areaID: string;
		position?: Position;
		network?: { id: string; name: string } | null;
		onBack?: () => void;
	}
	let { areaID, position = LAYOUT.content, network = null, onBack }: Props = $props();
	let unregisterArea: (() => void) | null = null;
	let removeBackHandler: (() => void) | null = null;
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0); // 0 = input, 1 = buttons row
	let selectedColumn = $state(0); // 0 = save as, 1 = back
	let inputRef: Input | undefined = $state();
	let browsingSaveAs = $state(false);
	let saveFolder = $state($storageLishnetPath);
	let saveFileName = $state(network ? `${network.name}.lishnet` : 'network.lishnet');
	let networkJson = $derived(network ? exportNetworkToJson(network.id) : ''); // Get full network data as JSON

	function openSaveAs() {
		browsingSaveAs = true;
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb($t.common?.saveAs);
		removeBackHandler = pushBackHandler(handleSaveAsBack);
	}

	async function handleSaveAsBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		browsingSaveAs = false;
		await tick();
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
	}

	async function handleSaveAsSelect(folderPath: string) {
		saveFolder = folderPath;
		const fullPath = joinPath(folderPath, saveFileName);
		// Write file via WebSocket API
		try {
			const result = await api.fs.writeText(fullPath, networkJson);
			if (!result.success) console.error('Failed to save file');
		} catch (e) {
			console.error('Failed to save file:', e);
		}
		handleSaveAsBack();
	}

	function registerAreaHandler() {
		return useArea(
			areaID,
			{
				up: () => {
					if (selectedIndex > 0) {
						selectedIndex--;
						return true;
					}
					return false;
				},
				down: () => {
					if (selectedIndex < 1) {
						selectedIndex++;
						selectedColumn = 0;
						return true;
					}
					return false;
				},
				left: () => {
					if (selectedIndex === 1 && selectedColumn > 0) {
						selectedColumn--;
						return true;
					}
					return false;
				},
				right: () => {
					if (selectedIndex === 1 && selectedColumn < 1) {
						selectedColumn++;
						return true;
					}
					return false;
				},
				confirmDown: () => {
					if (selectedIndex === 0) inputRef?.focus();
				},
				confirmUp: () => {
					if (selectedIndex === 1 && selectedColumn === 0) openSaveAs();
					else if (selectedIndex === 1 && selectedColumn === 1) onBack?.();
				},
				confirmCancel: () => {},
				back: () => onBack?.(),
			},
			position
		);
	}

	onMount(() => {
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
		return () => {
			if (unregisterArea) unregisterArea();
		};
	});
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

	.buttons {
		display: flex;
		justify-content: center;
		gap: 2vh;
	}
</style>

{#if browsingSaveAs}
	<FileBrowser {areaID} {position} initialPath={saveFolder} showPath foldersOnly selectFolderButton {saveFileName} onSaveFileNameChange={v => (saveFileName = v)} onSelect={handleSaveAsSelect} onBack={handleSaveAsBack} />
{:else}
	<div class="export">
		<div class="container">
			<Input bind:this={inputRef} value={networkJson} multiline rows={15} readonly fontSize="2vh" fontFamily="'Ubuntu Mono'" selected={active && selectedIndex === 0} />
		</div>
		<div class="buttons">
			<Button icon="/img/save.svg" label="{$t.common?.saveAs} ..." selected={active && selectedIndex === 1 && selectedColumn === 0} onConfirm={openSaveAs} />
			<Button icon="/img/back.svg" label={$t.common?.back} selected={active && selectedIndex === 1 && selectedColumn === 1} onConfirm={onBack} />
		</div>
	</div>
{/if}
