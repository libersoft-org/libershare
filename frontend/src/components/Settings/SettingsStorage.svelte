<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, setAreaPosition, removeArea, activateArea } from '../../scripts/areas.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { storagePath, storageTempPath, setStoragePath, setStorageTempPath } from '../../scripts/settings.ts';
	import Button from '../Buttons/Button.svelte';
	import Row from '../Row/Row.svelte';
	import SettingsStorageBrowse from './SettingsStorageBrowse.svelte';

	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();
	const browseAreaID = areaID + '-browse';
	let removeBackHandler: (() => void) | null = null;
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);
	let rowElements: HTMLElement[] = $state([]);
	let browsingFor = $state<'storage' | 'temp' | null>(null);
	const totalItems = 3; // 0 = download path, 1 = temp path, 2 = back button

	function openBrowse(type: 'storage' | 'temp') {
		browsingFor = type;
		setAreaPosition(areaID, { x: -999, y: -999 });
		setAreaPosition(browseAreaID, { x: 0, y: 2 });
		pushBreadcrumb(type === 'storage' ? ($t.settings?.storage?.folderDownload ?? 'Download folder') : ($t.settings?.storage?.folderTemp ?? 'Temp folder'));
		removeBackHandler = pushBackHandler(handleBrowseBack);
		activateArea(browseAreaID);
	}

	function changeStoragePath() {
		openBrowse('storage');
	}

	function changeStorageTempPath() {
		openBrowse('temp');
	}

	function handleBrowseSelect(path: string) {
		const normalizedPath = path.endsWith('/') || path.endsWith('\\') ? path : path + '/';
		if (browsingFor === 'storage') {
			setStoragePath(normalizedPath);
		} else if (browsingFor === 'temp') {
			setStorageTempPath(normalizedPath);
		}
		handleBrowseBack();
	}

	function handleBrowseBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		removeArea(browseAreaID);
		setAreaPosition(areaID, { x: 0, y: 2 });
		popBreadcrumb();
		browsingFor = null;
		registerAreaHandler();
		activateArea(areaID);
	}

	function registerAreaHandler() {
		return useArea(areaID, {
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
				else if (selectedIndex === totalItems - 1) onBack?.();
			},
			confirmCancel: () => {},
			back: () => onBack?.(),
		});
	}

	onMount(() => {
		return registerAreaHandler();
	});

	function scrollToSelected(): void {
		const element = rowElements[selectedIndex];
		if (element) {
			element.scrollIntoView({
				behavior: 'smooth',
				block: 'center',
			});
		}
	}
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
	<SettingsStorageBrowse areaID={browseAreaID} initialPath={browsingFor === 'storage' ? $storagePath : $storageTempPath} onSelect={handleBrowseSelect} onBack={handleBrowseBack} />
{:else}
	<div class="storage">
		<div class="rows">
			<div bind:this={rowElements[0]}>
				<Row selected={active && selectedIndex === 0}>
					<div class="info">
						<div class="label">{$t.settings?.storage?.folderDownload}</div>
						<div class="path">{$storagePath}</div>
					</div>
					<Button label={$t.common?.change} selected={active && selectedIndex === 0} onConfirm={changeStoragePath} />
				</Row>
			</div>
			<div bind:this={rowElements[1]}>
				<Row selected={active && selectedIndex === 1}>
					<div class="info">
						<div class="label">{$t.settings?.storage?.folderTemp}</div>
						<div class="path">{$storageTempPath}</div>
					</div>
					<Button label={$t.common?.change} selected={active && selectedIndex === 1} onConfirm={changeStorageTempPath} />
				</Row>
			</div>
		</div>
		<div class="back" bind:this={rowElements[totalItems - 1]}>
			<Button icon="/img/back.svg" label={$t.common?.back} selected={active && selectedIndex === totalItems - 1} onConfirm={onBack} />
		</div>
	</div>
{/if}
