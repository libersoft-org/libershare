<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { scrollToElement } from '../../scripts/utils.ts';
	import { autoStartOnBoot, showInTray, minimizeToTray, defaultMinifyJson, defaultCompressGzip, setAutoStartOnBoot, setShowInTray, setMinimizeToTray, setDefaultMinifyJson, setDefaultCompressGzip } from '../../scripts/settings.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	let unregisterArea: (() => void) | null = null;
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);
	let selectedColumn = $state(0);
	let rowElements: HTMLElement[] = $state([]);
	// Local state
	let autoStart = $state($autoStartOnBoot);
	let trayVisible = $state($showInTray);
	let trayMinimize = $state($minimizeToTray);
	let minifyJson = $state($defaultMinifyJson);
	let compressGzip = $state($defaultCompressGzip);
	// Field indices
	const FIELD_AUTO_START = 0;
	const FIELD_SHOW_IN_TRAY = 1;
	const FIELD_MINIMIZE_TO_TRAY = 2;
	const FIELD_MINIFY_JSON = 3;
	const FIELD_COMPRESS_GZIP = 4;
	const FIELD_BUTTONS = 5;
	// Calculate total visible items (skip MINIMIZE_TO_TRAY if tray not visible)
	let totalItems = $derived(trayVisible ? 6 : 5);

	function toggleAutoStart(): void {
		autoStart = !autoStart;
	}

	function toggleShowInTray(): void {
		trayVisible = !trayVisible;
		// Business rule: if disabling tray, also disable minimize to tray
		if (!trayVisible) trayMinimize = false;
	}

	function toggleMinimizeToTray(): void {
		trayMinimize = !trayMinimize;
	}

	function toggleMinifyJson(): void {
		minifyJson = !minifyJson;
	}

	function toggleCompressGzip(): void {
		compressGzip = !compressGzip;
	}

	function saveSettings(): void {
		setAutoStartOnBoot(autoStart);
		setShowInTray(trayVisible);
		setMinimizeToTray(trayMinimize);
		setDefaultMinifyJson(minifyJson);
		setDefaultCompressGzip(compressGzip);
		onBack?.();
	}

	function scrollToSelected(): void {
		scrollToElement(rowElements, selectedIndex);
	}

	// Get actual field index considering hidden items
	function getActualIndex(index: number): number {
		if (!trayVisible && index >= FIELD_MINIMIZE_TO_TRAY) return index + 1; // Skip MINIMIZE_TO_TRAY
		return index;
	}

	function registerAreaHandler(): () => void {
		return useArea(
			areaID,
			{
				up() {
					if (selectedIndex > 0) {
						selectedIndex--;
						selectedColumn = 0;
						scrollToSelected();
						return true;
					}
					return false;
				},
				down() {
					if (selectedIndex < totalItems - 1) {
						selectedIndex++;
						selectedColumn = 0;
						scrollToSelected();
						return true;
					}
					return false;
				},
				left() {
					const actualIndex = getActualIndex(selectedIndex);
					if (actualIndex === FIELD_BUTTONS && selectedColumn > 0) {
						selectedColumn--;
						return true;
					}
					return false;
				},
				right() {
					const actualIndex = getActualIndex(selectedIndex);
					if (actualIndex === FIELD_BUTTONS && selectedColumn < 1) {
						selectedColumn++;
						return true;
					}
					return false;
				},
				confirmDown() {},
				confirmUp() {
					const actualIndex = getActualIndex(selectedIndex);
					if (actualIndex === FIELD_AUTO_START) toggleAutoStart();
					else if (actualIndex === FIELD_SHOW_IN_TRAY) toggleShowInTray();
					else if (actualIndex === FIELD_MINIMIZE_TO_TRAY) toggleMinimizeToTray();
					else if (actualIndex === FIELD_MINIFY_JSON) toggleMinifyJson();
					else if (actualIndex === FIELD_COMPRESS_GZIP) toggleCompressGzip();
					else if (actualIndex === FIELD_BUTTONS) {
						if (selectedColumn === 0) saveSettings();
						else onBack?.();
					}
				},
				confirmCancel() {},
				back() {
					onBack?.();
				},
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
	.settings {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh;
		gap: 1vh;
		overflow-y: auto;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		width: 1000px;
		max-width: 100%;
	}
</style>

<div class="settings">
	<div class="container">
		<div bind:this={rowElements[0]}>
			<SwitchRow label={$t('settings.system.autoStartOnBoot') + ':'} checked={autoStart} selected={active && getActualIndex(selectedIndex) === FIELD_AUTO_START} onToggle={toggleAutoStart} />
		</div>
		<div bind:this={rowElements[1]}>
			<SwitchRow label={$t('settings.system.showInTray') + ':'} checked={trayVisible} selected={active && getActualIndex(selectedIndex) === FIELD_SHOW_IN_TRAY} onToggle={toggleShowInTray} />
		</div>
		{#if trayVisible}
			<div bind:this={rowElements[2]}>
				<SwitchRow label={$t('settings.system.minimizeToTray') + ':'} checked={trayMinimize} selected={active && getActualIndex(selectedIndex) === FIELD_MINIMIZE_TO_TRAY} onToggle={toggleMinimizeToTray} />
			</div>
		{/if}
		<div bind:this={rowElements[trayVisible ? 3 : 2]}>
			<SwitchRow label={$t('settings.system.defaultMinifyJson') + ':'} checked={minifyJson} selected={active && getActualIndex(selectedIndex) === FIELD_MINIFY_JSON} onToggle={toggleMinifyJson} />
		</div>
		<div bind:this={rowElements[trayVisible ? 4 : 3]}>
			<SwitchRow label={$t('settings.system.defaultCompressGzip') + ':'} checked={compressGzip} selected={active && getActualIndex(selectedIndex) === FIELD_COMPRESS_GZIP} onToggle={toggleCompressGzip} />
		</div>
	</div>
	<div bind:this={rowElements[trayVisible ? 5 : 4]}>
		<ButtonBar justify="center">
			<Button icon="/img/save.svg" label={$t('common.save')} selected={active && getActualIndex(selectedIndex) === FIELD_BUTTONS && selectedColumn === 0} onConfirm={saveSettings} />
			<Button icon="/img/back.svg" label={$t('common.back')} selected={active && getActualIndex(selectedIndex) === FIELD_BUTTONS && selectedColumn === 1} onConfirm={onBack} />
		</ButtonBar>
	</div>
</div>
