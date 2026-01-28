<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { maxDownloadConnections, maxUploadConnections, maxDownloadSpeed, maxUploadSpeed, autoStartSharing, setMaxDownloadConnections, setMaxUploadConnections, setMaxDownloadSpeed, setMaxUploadSpeed, setAutoStartSharing } from '../../scripts/settings.ts';
	import { scrollToElement } from '../../scripts/utils.ts';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
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
	let rowElements: HTMLElement[] = $state([]);

	// Local state for inputs
	let downloadConnections = $state($maxDownloadConnections.toString());
	let uploadConnections = $state($maxUploadConnections.toString());
	let downloadSpeed = $state($maxDownloadSpeed.toString());
	let uploadSpeed = $state($maxUploadSpeed.toString());
	let autoStart = $state($autoStartSharing);
	let selectedColumn = $state(0);

	let downloadConnectionsRef: Input;
	let uploadConnectionsRef: Input;
	let downloadSpeedRef: Input;
	let uploadSpeedRef: Input;

	const totalItems = 6; // 5 settings + buttons row (save, back)

	function saveAll() {
		saveDownloadConnections();
		saveUploadConnections();
		saveDownloadSpeed();
		saveUploadSpeed();
		// autoStartSharing is saved on toggle
	}

	function handleSave() {
		saveAll();
		onBack?.();
	}

	function saveDownloadConnections() {
		const value = parseInt(downloadConnections) || 0;
		setMaxDownloadConnections(Math.max(0, value));
		downloadConnections = Math.max(0, value).toString();
	}

	function saveUploadConnections() {
		const value = parseInt(uploadConnections) || 0;
		setMaxUploadConnections(Math.max(0, value));
		uploadConnections = Math.max(0, value).toString();
	}

	function saveDownloadSpeed() {
		const value = parseInt(downloadSpeed) || 0;
		setMaxDownloadSpeed(Math.max(0, value));
		downloadSpeed = Math.max(0, value).toString();
	}

	function saveUploadSpeed() {
		const value = parseInt(uploadSpeed) || 0;
		setMaxUploadSpeed(Math.max(0, value));
		uploadSpeed = Math.max(0, value).toString();
	}

	function toggleAutoStart() {
		autoStart = !autoStart;
		setAutoStartSharing(autoStart);
	}

	function scrollToSelected() {
		if (rowElements[selectedIndex]) {
			scrollToElement(rowElements[selectedIndex]);
		}
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
					if (selectedIndex === 5 && selectedColumn > 0) {
						selectedColumn--;
						return true;
					}
					return false;
				},
				right: () => {
					if (selectedIndex === 5 && selectedColumn < 1) {
						selectedColumn++;
						return true;
					}
					return false;
				},
				confirmDown: () => {
					if (selectedIndex === 0) downloadConnectionsRef?.focus();
					else if (selectedIndex === 1) uploadConnectionsRef?.focus();
					else if (selectedIndex === 2) downloadSpeedRef?.focus();
					else if (selectedIndex === 3) uploadSpeedRef?.focus();
				},
				confirmUp: () => {
					if (selectedIndex === 4) {
						toggleAutoStart();
					} else if (selectedIndex === 5) {
						if (selectedColumn === 0) {
							handleSave();
						} else {
							onBack?.();
						}
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
		<div bind:this={rowElements[0]}>
			<Input bind:this={downloadConnectionsRef} bind:value={downloadConnections} label={$t.settings?.download?.maxDownloadConnections} type="number" selected={active && selectedIndex === 0} onBlur={saveDownloadConnections} flex />
		</div>
		<div bind:this={rowElements[1]}>
			<Input bind:this={uploadConnectionsRef} bind:value={uploadConnections} label={$t.settings?.download?.maxUploadConnections} type="number" selected={active && selectedIndex === 1} onBlur={saveUploadConnections} flex />
		</div>
		<div bind:this={rowElements[2]}>
			<Input bind:this={downloadSpeedRef} bind:value={downloadSpeed} label={$t.settings?.download?.maxDownloadSpeed} type="number" selected={active && selectedIndex === 2} onBlur={saveDownloadSpeed} flex />
		</div>
		<div bind:this={rowElements[3]}>
			<Input bind:this={uploadSpeedRef} bind:value={uploadSpeed} label={$t.settings?.download?.maxUploadSpeed} type="number" selected={active && selectedIndex === 3} onBlur={saveUploadSpeed} flex />
		</div>
		<div class="switch-row" bind:this={rowElements[4]}>
			<span class="switch-label">{$t.settings?.download?.autoStartSharing}:</span>
			<Switch checked={autoStart} selected={active && selectedIndex === 4} onToggle={toggleAutoStart} />
		</div>
	</div>
	<div class="buttons" bind:this={rowElements[5]}>
		<Button icon="/img/save.svg" label={$t.common?.save} selected={active && selectedIndex === 5 && selectedColumn === 0} onConfirm={handleSave} />
		<Button icon="/img/back.svg" label={$t.common?.back} selected={active && selectedIndex === 5 && selectedColumn === 1} onConfirm={onBack} />
	</div>
</div>
