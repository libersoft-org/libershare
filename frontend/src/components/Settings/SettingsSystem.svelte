<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { scrollToElement } from '../../scripts/utils.ts';
	import { autoStartOnBoot, showInTray, minimizeToTray, setAutoStartOnBoot, setShowInTray, setMinimizeToTray } from '../../scripts/settings.ts';
	import Button from '../Buttons/Button.svelte';
	import Switch from '../Switch/Switch.svelte';
	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
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
	// Field indices
	const FIELD_AUTO_START = 0;
	const FIELD_SHOW_IN_TRAY = 1;
	const FIELD_MINIMIZE_TO_TRAY = 2;
	const FIELD_BUTTONS = 3;
	// Calculate total visible items
	let totalItems = $derived(trayVisible ? 4 : 3);

	function toggleAutoStart() {
		autoStart = !autoStart;
		setAutoStartOnBoot(autoStart);
	}

	function toggleShowInTray() {
		trayVisible = !trayVisible;
		setShowInTray(trayVisible);
		// If we disable tray, also disable minimize to tray
		if (!trayVisible && trayMinimize) {
			trayMinimize = false;
			setMinimizeToTray(false);
		}
	}

	function toggleMinimizeToTray() {
		trayMinimize = !trayMinimize;
		setMinimizeToTray(trayMinimize);
	}

	const scrollToSelected = () => scrollToElement(rowElements, selectedIndex);

	// Get actual field index considering hidden items
	function getActualIndex(index: number): number {
		if (!trayVisible && index >= FIELD_MINIMIZE_TO_TRAY) return index + 1; // Skip MINIMIZE_TO_TRAY
		return index;
	}

	// Get visual index from actual field index
	function getVisualIndex(actualIndex: number): number {
		if (!trayVisible && actualIndex > FIELD_SHOW_IN_TRAY) return actualIndex - 1;
		return actualIndex;
	}

	function registerAreaHandler() {
		return useArea(
			areaID,
			{
				up: () => {
					if (selectedIndex > 0) {
						selectedIndex--;
						selectedColumn = 0;
						scrollToSelected();
						return true;
					}
					return false;
				},
				down: () => {
					if (selectedIndex < totalItems - 1) {
						selectedIndex++;
						selectedColumn = 0;
						scrollToSelected();
						return true;
					}
					return false;
				},
				left: () => {
					const actualIndex = getActualIndex(selectedIndex);
					if (actualIndex === FIELD_BUTTONS && selectedColumn > 0) {
						selectedColumn--;
						return true;
					}
					return false;
				},
				right: () => {
					const actualIndex = getActualIndex(selectedIndex);
					if (actualIndex === FIELD_BUTTONS && selectedColumn < 1) {
						selectedColumn++;
						return true;
					}
					return false;
				},
				confirmDown: () => {},
				confirmUp: () => {
					const actualIndex = getActualIndex(selectedIndex);
					if (actualIndex === FIELD_AUTO_START) toggleAutoStart();
					else if (actualIndex === FIELD_SHOW_IN_TRAY) toggleShowInTray();
					else if (actualIndex === FIELD_MINIMIZE_TO_TRAY) toggleMinimizeToTray();
					else if (actualIndex === FIELD_BUTTONS) {
						if (selectedColumn === 0) onBack?.();
						else onBack?.();
					}
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

	.buttons {
		display: flex;
		justify-content: center;
		gap: 2vh;
		padding-top: 2vh;
	}

	.switch-label {
		font-size: 2vh;
		color: var(--secondary-foreground);
	}

	.switch-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1vh 0;
	}
</style>

<div class="settings">
	<div class="container">
		<div class="switch-row" bind:this={rowElements[0]}>
			<span class="switch-label">{$t.settings?.system?.autoStartOnBoot}:</span>
			<Switch checked={autoStart} selected={active && getActualIndex(selectedIndex) === FIELD_AUTO_START} onToggle={toggleAutoStart} />
		</div>
		<div class="switch-row" bind:this={rowElements[1]}>
			<span class="switch-label">{$t.settings?.system?.showInTray}:</span>
			<Switch checked={trayVisible} selected={active && getActualIndex(selectedIndex) === FIELD_SHOW_IN_TRAY} onToggle={toggleShowInTray} />
		</div>
		{#if trayVisible}
			<div class="switch-row" bind:this={rowElements[2]}>
				<span class="switch-label">{$t.settings?.system?.minimizeToTray}:</span>
				<Switch checked={trayMinimize} selected={active && getActualIndex(selectedIndex) === FIELD_MINIMIZE_TO_TRAY} onToggle={toggleMinimizeToTray} />
			</div>
		{/if}
	</div>
	<div class="buttons" bind:this={rowElements[trayVisible ? 3 : 2]}>
		<Button icon="/img/save.svg" label={$t.common?.save} selected={active && getActualIndex(selectedIndex) === FIELD_BUTTONS && selectedColumn === 0} onConfirm={onBack} />
		<Button icon="/img/back.svg" label={$t.common?.back} selected={active && getActualIndex(selectedIndex) === FIELD_BUTTONS && selectedColumn === 1} onConfirm={onBack} />
	</div>
</div>
