<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { type LISHNetworkConfig } from '@shared';
	import { getNetworks, exportAllNetworksToJson } from '../../scripts/lishNetwork.ts';
	import { storageLishnetPath, defaultMinifyJson, defaultCompressGzip } from '../../scripts/settings.ts';
	import { minifyJson } from '../../scripts/utils.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	let unregisterArea: (() => void) | null = null;
	let removeBackHandler: (() => void) | null = null;
	let active = $derived($activeArea === areaID);
	let networks = $state<LISHNetworkConfig[]>([]);
	let hasNetworks = $derived(networks.length > 0);
	let selectedIndex = $state(0); // 0 = input (if has networks), 1 = minify switch, 2 = gzip switch, 3 = buttons row
	let selectedColumn = $state(0); // 0 = save as, 1 = back
	let inputRef: Input | undefined = $state();
	let browsingSaveAs = $state(false);
	let saveFolder = $state($storageLishnetPath);
	let baseFileName = $state('networks.lishnets');
	let minifyJsonState = $state($defaultMinifyJson);
	let compressGzip = $state($defaultCompressGzip);
	let networksJson = $state('');

	// Compute final filename with .gz extension if gzip is enabled
	let saveFileName = $derived(compressGzip ? `${baseFileName}.gz` : baseFileName);

	// Compute save content based on minify setting
	let saveContent = $derived(minifyJsonState ? minifyJson(networksJson) : networksJson);

	async function loadData(): Promise<void> {
		networks = await getNetworks();
		networksJson = await exportAllNetworksToJson();
	}

	function openSaveAs(): void {
		browsingSaveAs = true;
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb($t('common.saveAs'));
		removeBackHandler = pushBackHandler(handleSaveAsBack);
	}

	async function handleSaveAsBack(): Promise<void> {
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

	function handleSaveComplete(path: string): void {
		handleSaveAsBack();
	}

	function registerAreaHandler(): () => void {
		return useArea(
			areaID,
			{
				up: () => {
					if (hasNetworks && selectedIndex > 0) {
						selectedIndex--;
						return true;
					}
					return false;
				},
				down: () => {
					if (hasNetworks && selectedIndex < 3) {
						selectedIndex++;
						selectedColumn = 0;
						return true;
					}
					return false;
				},
				left: () => {
					if (selectedIndex === 3 && selectedColumn > 0) {
						selectedColumn--;
						return true;
					}
					return false;
				},
				right: () => {
					if (selectedIndex === 3 && selectedColumn < 1) {
						selectedColumn++;
						return true;
					}
					return false;
				},
				confirmDown: () => {
					if (hasNetworks && selectedIndex === 0) inputRef?.focus();
				},
				confirmUp: () => {
					if (hasNetworks && selectedIndex === 1) minifyJsonState = !minifyJsonState;
					else if (hasNetworks && selectedIndex === 2) compressGzip = !compressGzip;
					else if (hasNetworks && selectedIndex === 3 && selectedColumn === 0) openSaveAs();
					else if (hasNetworks && selectedIndex === 3 && selectedColumn === 1) onBack?.();
					else if (!hasNetworks) onBack?.();
				},
				confirmCancel: () => {},
				back: () => onBack?.(),
			},
			position
		);
	}

	onMount(() => {
		loadData().then(() => {
			unregisterArea = registerAreaHandler();
			activateArea(areaID);
		});
		return () => {
			if (unregisterArea) unregisterArea();
		};
	});
</script>

<style>
	.export-all {
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
</style>

{#if browsingSaveAs}
	<FileBrowser {areaID} {position} initialPath={saveFolder} showPath fileFilter={compressGzip ? ['*.lishnets.gz'] : ['*.lishnets']} {saveFileName} {saveContent} useGzip={compressGzip} onSaveFileNameChange={v => (saveFileName = v)} onSaveComplete={handleSaveComplete} onBack={handleSaveAsBack} />
{:else}
	<div class="export-all">
		<div class="container">
			{#if hasNetworks}
				<Input bind:this={inputRef} value={networksJson} multiline rows={15} readonly fontSize="2vh" fontFamily="'Ubuntu Mono'" selected={active && selectedIndex === 0} />
				<SwitchRow label={$t('settings.lishNetwork.minifyJson')} checked={minifyJsonState} selected={active && selectedIndex === 1} onToggle={() => (minifyJsonState = !minifyJsonState)} />
				<SwitchRow label={$t('settings.lishNetwork.compressGzip')} checked={compressGzip} selected={active && selectedIndex === 2} onToggle={() => (compressGzip = !compressGzip)} />
			{:else}
				<Alert type="warning" message={$t('settings.lishNetwork.emptyList')} />
			{/if}
		</div>
		<ButtonBar justify="center">
			{#if hasNetworks}
				<Button icon="/img/save.svg" label="{$t('common.saveAs')} ..." selected={active && selectedIndex === 3 && selectedColumn === 0} onConfirm={openSaveAs} />
			{/if}
			<Button icon="/img/back.svg" label={$t('common.back')} selected={active && (hasNetworks ? selectedIndex === 3 && selectedColumn === 1 : true)} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
