<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { exportNetworkToJson } from '../../scripts/lishNetwork.ts';
	import { storageLISHnetPath, defaultMinifyJson, defaultCompressGzip } from '../../scripts/settings.ts';
	import { minifyJson } from '../../scripts/utils.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		network?: { id: string; name: string } | null | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, network = null, onBack }: Props = $props();
	let unregisterArea: (() => void) | null = null;
	let removeBackHandler: (() => void) | null = null;
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0); // 0 = input, 1 = minify switch, 2 = gzip switch, 3 = buttons row
	let selectedColumn = $state(0); // 0 = save as, 1 = back
	let inputRef: Input | undefined = $state();
	let browsingSaveAs = $state(false);
	let saveFolder = $state($storageLISHnetPath);
	function getInitialBaseFileName(): string {
		return network ? `${network.name}.lishnet` : 'network.lishnet';
	}
	let baseFileName = $state(getInitialBaseFileName());
	let networkJson = $state(''); // Get full network data as JSON (editable)
	let minifyJsonState = $state($defaultMinifyJson);
	let compressGzip = $state($defaultCompressGzip);
	let errorMessage = $state('');

	// Load network JSON on mount
	onMount(() => {
		const init = async () => {
			if (network) networkJson = await exportNetworkToJson(network.id);
			unregisterArea = registerAreaHandler();
			activateArea(areaID);
		};
		init();
		return () => {
			if (unregisterArea) unregisterArea();
		};
	});

	// Compute final filename with .gz extension if gzip is enabled
	let saveFileName = $derived(compressGzip ? `${baseFileName}.gz` : baseFileName);

	// Compute save content based on minify setting
	let saveContent = $derived(minifyJsonState ? minifyJson(networkJson) : networkJson);

	function getBaseFileNameFromJson(): string {
		try {
			const parsed = JSON.parse(networkJson);
			if (parsed.name && typeof parsed.name === 'string' && parsed.name.trim()) return `${parsed.name.trim()}.lishnet`;
			if (parsed.networkID && typeof parsed.networkID === 'string' && parsed.networkID.trim()) return `${parsed.networkID.trim()}.lishnet`;
		} catch {}
		return 'network.lishnet';
	}

	function openSaveAs(): void {
		errorMessage = '';
		try {
			const parsed = JSON.parse(networkJson);
			if (!parsed.name || typeof parsed.name !== 'string' || !parsed.name.trim()) {
				errorMessage = $t('settings.lishNetwork.errorNameRequired');
				return;
			}
			if (!parsed.networkID || typeof parsed.networkID !== 'string' || !parsed.networkID.trim()) {
				errorMessage = $t('settings.lishNetwork.errorNetworkIDRequired');
				return;
			}
		} catch {
			errorMessage = $t('settings.lishNetwork.errorInvalidFormat');
			return;
		}
		baseFileName = getBaseFileNameFromJson();
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

	function registerAreaHandler(): () => void {
		return useArea(
			areaID,
			{
				up() {
					if (selectedIndex > 0) {
						selectedIndex--;
						return true;
					}
					return false;
				},
				down() {
					if (selectedIndex < 3) {
						selectedIndex++;
						selectedColumn = 0;
						return true;
					}
					return false;
				},
				left() {
					if (selectedIndex === 3 && selectedColumn > 0) {
						selectedColumn--;
						return true;
					}
					return false;
				},
				right() {
					if (selectedIndex === 3 && selectedColumn < 1) {
						selectedColumn++;
						return true;
					}
					return false;
				},
				confirmDown() {
					if (selectedIndex === 0) inputRef?.focus();
				},
				confirmUp() {
					if (selectedIndex === 1) minifyJsonState = !minifyJsonState;
					else if (selectedIndex === 2) compressGzip = !compressGzip;
					else if (selectedIndex === 3 && selectedColumn === 0) openSaveAs();
					else if (selectedIndex === 3 && selectedColumn === 1) onBack?.();
				},
				confirmCancel() {},
				back() {
					onBack?.();
				},
			},
			position
		);
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
</style>

{#if browsingSaveAs}
	<FileBrowser {areaID} {position} initialPath={saveFolder} showPath fileFilter={compressGzip ? ['*.lishnet.gz'] : ['*.lishnet']} {saveFileName} {saveContent} useGzip={compressGzip} onSaveFileNameChange={v => (saveFileName = v)} onSaveComplete={handleSaveAsBack} onBack={handleSaveAsBack} />
{:else}
	<div class="export">
		<div class="container">
			<Input bind:this={inputRef} bind:value={networkJson} multiline rows={15} fontSize="2vh" fontFamily="'Ubuntu Mono'" selected={active && selectedIndex === 0} />
			<SwitchRow label={$t('settings.lishNetwork.minifyJson')} checked={minifyJsonState} selected={active && selectedIndex === 1} onToggle={() => (minifyJsonState = !minifyJsonState)} />
			<SwitchRow label={$t('settings.lishNetwork.compressGzip')} checked={compressGzip} selected={active && selectedIndex === 2} onToggle={() => (compressGzip = !compressGzip)} />
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center">
			<Button icon="/img/save.svg" label="{$t('common.saveAs')} ..." selected={active && selectedIndex === 3 && selectedColumn === 0} onConfirm={openSaveAs} />
			<Button icon="/img/back.svg" label={$t('common.back')} selected={active && selectedIndex === 3 && selectedColumn === 1} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
