<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { storagePath, storageTempPath, storageLishPath, setStoragePath, setStorageTempPath, setStorageLishPath } from '../../scripts/settings.ts';
	import { scrollToElement } from '../../scripts/utils.ts';
	import Button from '../Buttons/Button.svelte';
	import Row from '../Row/Row.svelte';
	import SettingsStorageBrowse from './SettingsStorageBrowse.svelte';

	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	let unregisterArea: (() => void) | null = null;
	let removeBackHandler: (() => void) | null = null;
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);
	let rowElements: HTMLElement[] = $state([]);
	let browsingFor = $state<'storage' | 'temp' | 'lish' | null>(null);
	const totalItems = 4; // 0 = download path, 1 = temp path, 2 = lish path, 3 = back button

	function openBrowse(type: 'storage' | 'temp' | 'lish') {
		browsingFor = type;
		// Unregister our area - FileBrowser will create its own sub-areas
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		const labels = {
			storage: $t.settings?.storage?.folderDownload,
			temp: $t.settings?.storage?.folderTemp,
			lish: $t.settings?.storage?.folderLish,
		};
		pushBreadcrumb(labels[type]);
		removeBackHandler = pushBackHandler(handleBrowseBack);
		// FileBrowser will activate its list area on mount
	}

	function changeStoragePath() {
		openBrowse('storage');
	}

	function changeStorageTempPath() {
		openBrowse('temp');
	}

	function changeStorageLishPath() {
		openBrowse('lish');
	}

	function handleBrowseSelect(path: string) {
		const normalizedPath = path.endsWith('/') || path.endsWith('\\') ? path : path + '/';
		if (browsingFor === 'storage') {
			setStoragePath(normalizedPath);
		} else if (browsingFor === 'temp') {
			setStorageTempPath(normalizedPath);
		} else if (browsingFor === 'lish') {
			setStorageLishPath(normalizedPath);
		}
		handleBrowseBack();
	}

	async function handleBrowseBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		// FileBrowser's sub-areas are cleaned up automatically when it unmounts
		popBreadcrumb();
		browsingFor = null;
		// Wait for sub-component to unmount before re-registering
		await tick();
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
	}

	function registerAreaHandler() {
		return useArea(
			areaID,
			{
				up: () => {
					if (selectedIndex > 0) {
						selectedIndex--;
						scrollToSelected();
						return true;
					}
					return false;
				},
				down: () => {
					if (selectedIndex < totalItems - 1) {
						selectedIndex++;
						scrollToSelected();
						return true;
					}
					return false;
				},
				left: () => false,
				right: () => false,
				confirmDown: () => {},
				confirmUp: () => {
					if (selectedIndex === 0) changeStoragePath();
					else if (selectedIndex === 1) changeStorageTempPath();
					else if (selectedIndex === 2) changeStorageLishPath();
					else if (selectedIndex === totalItems - 1) onBack?.();
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

	const scrollToSelected = () => scrollToElement(rowElements, selectedIndex);
</script>

<style>
	.storage {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh;
		gap: 2vh;
		overflow-y: auto;
	}

	.rows {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		width: 1000px;
		max-width: 100%;
	}

	.info {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5vh;
	}

	.info .label {
		font-size: 2vh;
		color: var(--disabled-foreground);
	}

	.info .path {
		font-size: 3vh;
		font-weight: bold;
		color: var(--secondary-foreground);
	}

	.back {
		margin-top: 2vh;
	}
</style>

{#if browsingFor}
	<SettingsStorageBrowse areaID={areaID} {position} initialPath={browsingFor === 'storage' ? $storagePath : browsingFor === 'temp' ? $storageTempPath : $storageLishPath} onSelect={handleBrowseSelect} onBack={handleBrowseBack} />
{:else}
	<div class="storage">
		<div class="rows">
			<div bind:this={rowElements[0]}>
				<Row selected={active && selectedIndex === 0}>
					<div class="info">
						<div class="label">{$t.settings?.storage?.folderDownload}</div>
						<div class="path">{$storagePath}</div>
					</div>
					<Button icon="/img/edit.svg" label={$t.common?.change} selected={active && selectedIndex === 0} onConfirm={changeStoragePath} />
				</Row>
			</div>
			<div bind:this={rowElements[1]}>
				<Row selected={active && selectedIndex === 1}>
					<div class="info">
						<div class="label">{$t.settings?.storage?.folderTemp}</div>
						<div class="path">{$storageTempPath}</div>
					</div>
					<Button icon="/img/edit.svg" label={$t.common?.change} selected={active && selectedIndex === 1} onConfirm={changeStorageTempPath} />
				</Row>
			</div>
			<div bind:this={rowElements[2]}>
				<Row selected={active && selectedIndex === 2}>
					<div class="info">
						<div class="label">{$t.settings?.storage?.folderLish}</div>
						<div class="path">{$storageLishPath}</div>
					</div>
					<Button icon="/img/edit.svg" label={$t.common?.change} selected={active && selectedIndex === 2} onConfirm={changeStorageLishPath} />
				</Row>
			</div>
		</div>
		<div class="back" bind:this={rowElements[totalItems - 1]}>
			<Button icon="/img/back.svg" label={$t.common?.back} selected={active && selectedIndex === totalItems - 1} onConfirm={onBack} />
		</div>
	</div>
{/if}
