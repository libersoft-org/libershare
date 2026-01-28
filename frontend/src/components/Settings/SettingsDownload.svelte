<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { storagePath, storageTempPath, storageLishPath, setStoragePath, setStorageTempPath, setStorageLishPath, incomingPort, maxDownloadConnections, maxUploadConnections, maxDownloadSpeed, maxUploadSpeed, autoStartSharing, setIncomingPort, setMaxDownloadConnections, setMaxUploadConnections, setMaxDownloadSpeed, setMaxUploadSpeed, setAutoStartSharing } from '../../scripts/settings.ts';
	import { scrollToElement, normalizePath } from '../../scripts/utils.ts';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
	import SwitchRow from '../Switch/SwitchRow.svelte';
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
	let selectedColumn = $state(0);
	let rowElements: HTMLElement[] = $state([]);
	let browsingFor = $state<'storage' | 'temp' | 'lish' | null>(null);

	// Local state for inputs
	let storagePathValue = $state($storagePath);
	let tempPathValue = $state($storageTempPath);
	let lishPathValue = $state($storageLishPath);
	let port = $state($incomingPort.toString());
	let downloadConnections = $state($maxDownloadConnections.toString());
	let uploadConnections = $state($maxUploadConnections.toString());
	let downloadSpeed = $state($maxDownloadSpeed.toString());
	let uploadSpeed = $state($maxUploadSpeed.toString());
	let autoStart = $state($autoStartSharing);

	let storagePathRef: Input;
	let tempPathRef: Input;
	let lishPathRef: Input;
	let portRef: Input;
	let downloadConnectionsRef: Input;
	let uploadConnectionsRef: Input;
	let downloadSpeedRef: Input;
	let uploadSpeedRef: Input;

	// Field indices
	const FIELD_STORAGE_PATH = 0;
	const FIELD_TEMP_PATH = 1;
	const FIELD_LISH_PATH = 2;
	const FIELD_PORT = 3;
	const FIELD_DOWNLOAD_CONNECTIONS = 4;
	const FIELD_UPLOAD_CONNECTIONS = 5;
	const FIELD_DOWNLOAD_SPEED = 6;
	const FIELD_UPLOAD_SPEED = 7;
	const FIELD_AUTO_START = 8;
	const FIELD_BUTTONS = 9;
	const totalItems = 10;

	// Browse functions
	function openBrowse(type: 'storage' | 'temp' | 'lish') {
		browsingFor = type;
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		const labels = {
			storage: $t.settings?.download?.folderDownload,
			temp: $t.settings?.download?.folderTemp,
			lish: $t.settings?.download?.folderLish,
		};
		pushBreadcrumb(labels[type]);
		removeBackHandler = pushBackHandler(handleBrowseBack);
	}

	function handleBrowseSelect(path: string) {
		const normalizedPath = normalizePath(path);
		if (browsingFor === 'storage') {
			setStoragePath(normalizedPath);
			storagePathValue = normalizedPath;
		} else if (browsingFor === 'temp') {
			setStorageTempPath(normalizedPath);
			tempPathValue = normalizedPath;
		} else if (browsingFor === 'lish') {
			setStorageLishPath(normalizedPath);
			lishPathValue = normalizedPath;
		}
		handleBrowseBack();
	}

	async function handleBrowseBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		browsingFor = null;
		await tick();
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
	}

	// Save functions
	function savePort() {
		setIncomingPort(parseInt(port) || 9090);
		port = $incomingPort.toString();
	}

	function saveDownloadConnections() {
		setMaxDownloadConnections(parseInt(downloadConnections) || 0);
		downloadConnections = $maxDownloadConnections.toString();
	}

	function saveUploadConnections() {
		setMaxUploadConnections(parseInt(uploadConnections) || 0);
		uploadConnections = $maxUploadConnections.toString();
	}

	function saveDownloadSpeed() {
		setMaxDownloadSpeed(parseInt(downloadSpeed) || 0);
		downloadSpeed = $maxDownloadSpeed.toString();
	}

	function saveUploadSpeed() {
		setMaxUploadSpeed(parseInt(uploadSpeed) || 0);
		uploadSpeed = $maxUploadSpeed.toString();
	}

	function saveAll() {
		savePort();
		saveDownloadConnections();
		saveUploadConnections();
		saveDownloadSpeed();
		saveUploadSpeed();
	}

	function handleSave() {
		saveAll();
		onBack?.();
	}

	function toggleAutoStart() {
		autoStart = !autoStart;
		setAutoStartSharing(autoStart);
	}

	const scrollToSelected = () => scrollToElement(rowElements, selectedIndex);

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
					if ((selectedIndex === FIELD_STORAGE_PATH || selectedIndex === FIELD_TEMP_PATH || selectedIndex === FIELD_LISH_PATH || selectedIndex === FIELD_BUTTONS) && selectedColumn > 0) {
						selectedColumn--;
						return true;
					}
					return false;
				},
				right: () => {
					if ((selectedIndex === FIELD_STORAGE_PATH || selectedIndex === FIELD_TEMP_PATH || selectedIndex === FIELD_LISH_PATH || selectedIndex === FIELD_BUTTONS) && selectedColumn < 1) {
						selectedColumn++;
						return true;
					}
					return false;
				},
				confirmDown: () => {
					if (selectedIndex === FIELD_STORAGE_PATH && selectedColumn === 0) storagePathRef?.focus();
					else if (selectedIndex === FIELD_TEMP_PATH && selectedColumn === 0) tempPathRef?.focus();
					else if (selectedIndex === FIELD_LISH_PATH && selectedColumn === 0) lishPathRef?.focus();
					else if (selectedIndex === FIELD_PORT) portRef?.focus();
					else if (selectedIndex === FIELD_DOWNLOAD_CONNECTIONS) downloadConnectionsRef?.focus();
					else if (selectedIndex === FIELD_UPLOAD_CONNECTIONS) uploadConnectionsRef?.focus();
					else if (selectedIndex === FIELD_DOWNLOAD_SPEED) downloadSpeedRef?.focus();
					else if (selectedIndex === FIELD_UPLOAD_SPEED) uploadSpeedRef?.focus();
				},
				confirmUp: () => {
					if (selectedIndex === FIELD_STORAGE_PATH && selectedColumn === 1) openBrowse('storage');
					else if (selectedIndex === FIELD_TEMP_PATH && selectedColumn === 1) openBrowse('temp');
					else if (selectedIndex === FIELD_LISH_PATH && selectedColumn === 1) openBrowse('lish');
					else if (selectedIndex === FIELD_AUTO_START) toggleAutoStart();
					else if (selectedIndex === FIELD_BUTTONS) {
						if (selectedColumn === 0) handleSave();
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

	.row {
		display: flex;
		gap: 1vh;
		align-items: flex-end;
	}
</style>

{#if browsingFor}
	<SettingsStorageBrowse {areaID} {position} initialPath={browsingFor === 'storage' ? $storagePath : browsingFor === 'temp' ? $storageTempPath : $storageLishPath} onSelect={handleBrowseSelect} onBack={handleBrowseBack} />
{:else}
	<div class="settings">
		<div class="container">
			<!-- Storage paths -->
			<div class="row" bind:this={rowElements[FIELD_STORAGE_PATH]}>
				<Input bind:this={storagePathRef} bind:value={storagePathValue} label={$t.settings?.download?.folderDownload} selected={active && selectedIndex === FIELD_STORAGE_PATH && selectedColumn === 0} onBlur={() => setStoragePath(storagePathValue)} flex />
				<Button icon="/img/folder.svg" selected={active && selectedIndex === FIELD_STORAGE_PATH && selectedColumn === 1} onConfirm={() => openBrowse('storage')} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row" bind:this={rowElements[FIELD_TEMP_PATH]}>
				<Input bind:this={tempPathRef} bind:value={tempPathValue} label={$t.settings?.download?.folderTemp} selected={active && selectedIndex === FIELD_TEMP_PATH && selectedColumn === 0} onBlur={() => setStorageTempPath(tempPathValue)} flex />
				<Button icon="/img/folder.svg" selected={active && selectedIndex === FIELD_TEMP_PATH && selectedColumn === 1} onConfirm={() => openBrowse('temp')} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row" bind:this={rowElements[FIELD_LISH_PATH]}>
				<Input bind:this={lishPathRef} bind:value={lishPathValue} label={$t.settings?.download?.folderLish} selected={active && selectedIndex === FIELD_LISH_PATH && selectedColumn === 0} onBlur={() => setStorageLishPath(lishPathValue)} flex />
				<Button icon="/img/folder.svg" selected={active && selectedIndex === FIELD_LISH_PATH && selectedColumn === 1} onConfirm={() => openBrowse('lish')} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<!-- Network settings -->
			<div bind:this={rowElements[FIELD_PORT]}>
				<Input bind:this={portRef} bind:value={port} label={$t.settings?.download?.incomingPort} type="number" selected={active && selectedIndex === FIELD_PORT} onBlur={savePort} flex />
			</div>
			<div bind:this={rowElements[FIELD_DOWNLOAD_CONNECTIONS]}>
				<Input bind:this={downloadConnectionsRef} bind:value={downloadConnections} label={$t.settings?.download?.maxDownloadConnections} type="number" selected={active && selectedIndex === FIELD_DOWNLOAD_CONNECTIONS} onBlur={saveDownloadConnections} flex />
			</div>
			<div bind:this={rowElements[FIELD_UPLOAD_CONNECTIONS]}>
				<Input bind:this={uploadConnectionsRef} bind:value={uploadConnections} label={$t.settings?.download?.maxUploadConnections} type="number" selected={active && selectedIndex === FIELD_UPLOAD_CONNECTIONS} onBlur={saveUploadConnections} flex />
			</div>
			<div bind:this={rowElements[FIELD_DOWNLOAD_SPEED]}>
				<Input bind:this={downloadSpeedRef} bind:value={downloadSpeed} label={$t.settings?.download?.maxDownloadSpeed} type="number" selected={active && selectedIndex === FIELD_DOWNLOAD_SPEED} onBlur={saveDownloadSpeed} flex />
			</div>
			<div bind:this={rowElements[FIELD_UPLOAD_SPEED]}>
				<Input bind:this={uploadSpeedRef} bind:value={uploadSpeed} label={$t.settings?.download?.maxUploadSpeed} type="number" selected={active && selectedIndex === FIELD_UPLOAD_SPEED} onBlur={saveUploadSpeed} flex />
			</div>
			<div bind:this={rowElements[FIELD_AUTO_START]}>
				<SwitchRow label={$t.settings?.download?.autoStartSharing + ':'} checked={autoStart} selected={active && selectedIndex === FIELD_AUTO_START} onToggle={toggleAutoStart} />
			</div>
		</div>
		<div class="buttons" bind:this={rowElements[FIELD_BUTTONS]}>
			<Button icon="/img/save.svg" label={$t.common?.save} selected={active && selectedIndex === FIELD_BUTTONS && selectedColumn === 0} onConfirm={handleSave} />
			<Button icon="/img/back.svg" label={$t.common?.back} selected={active && selectedIndex === FIELD_BUTTONS && selectedColumn === 1} onConfirm={onBack} />
		</div>
	</div>
{/if}