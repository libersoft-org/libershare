<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { storagePath, storageTempPath, storageLISHPath, storageLISHnetPath, setStoragePath, setStorageTempPath, setStorageLISHPath, setStorageLISHnetPath, incomingPort, maxDownloadConnections, maxUploadConnections, maxDownloadSpeed, maxUploadSpeed, allowRelay, maxRelayReservations, autoStartSharing, setIncomingPort, setMaxDownloadConnections, setMaxUploadConnections, setMaxDownloadSpeed, setMaxUploadSpeed, setAllowRelay, setMaxRelayReservations, setAutoStartSharing, settingsDefaults } from '../../scripts/settings.ts';
	import { scrollToElement, normalizePath } from '../../scripts/utils.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	import SettingsStorageBrowse from './SettingsStorageBrowse.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	let unregisterArea: (() => void) | null = null;
	let removeBackHandler: (() => void) | null = null;
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);
	let selectedColumn = $state(0);
	let rowElements: HTMLElement[] = $state([]);
	let browsingFor = $state<'storage' | 'temp' | 'lish' | 'lishnet' | null>(null);

	// Local state for inputs
	let storagePathValue = $state($storagePath);
	let tempPathValue = $state($storageTempPath);
	let lishPathValue = $state($storageLISHPath);
	let lishnetPathValue = $state($storageLISHnetPath);
	let port = $state($incomingPort.toString());
	let downloadConnections = $state($maxDownloadConnections.toString());
	let uploadConnections = $state($maxUploadConnections.toString());
	let downloadSpeed = $state($maxDownloadSpeed.toString());
	let uploadSpeed = $state($maxUploadSpeed.toString());
	let relay = $state($allowRelay);
	let relayReservations = $state($maxRelayReservations.toString());
	let autoStart = $state($autoStartSharing);

	let storagePathRef: Input | undefined = $state();
	let tempPathRef: Input | undefined = $state();
	let lishPathRef: Input | undefined = $state();
	let lishnetPathRef: Input | undefined = $state();
	let portRef: Input | undefined = $state();
	let downloadConnectionsRef: Input | undefined = $state();
	let uploadConnectionsRef: Input | undefined = $state();
	let downloadSpeedRef: Input | undefined = $state();
	let uploadSpeedRef: Input | undefined = $state();
	let relayReservationsRef: Input | undefined = $state();

	// Field indices
	const FIELD_STORAGE_PATH = 0;
	const FIELD_TEMP_PATH = 1;
	const FIELD_LISH_PATH = 2;
	const FIELD_LISHNET_PATH = 3;
	const FIELD_PORT = 4;
	const FIELD_DOWNLOAD_CONNECTIONS = 5;
	const FIELD_UPLOAD_CONNECTIONS = 6;
	const FIELD_DOWNLOAD_SPEED = 7;
	const FIELD_UPLOAD_SPEED = 8;
	const FIELD_ALLOW_RELAY = 9;
	const FIELD_RELAY_RESERVATIONS = 10;
	const FIELD_AUTO_START = 11;
	const FIELD_BUTTONS = 12;
	const totalItems = 13;

	// Browse functions
	function openBrowse(type: 'storage' | 'temp' | 'lish' | 'lishnet'): void {
		browsingFor = type;
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		const labels = {
			storage: $t('settings.download.folderDownload'),
			temp: $t('settings.download.folderTemp'),
			lish: $t('settings.download.folderLISH'),
			lishnet: $t('settings.download.folderLISHnet'),
		};
		pushBreadcrumb(labels[type]);
		removeBackHandler = pushBackHandler(handleBrowseBack);
	}

	function handleBrowseSelect(path: string): void {
		const normalizedPath = normalizePath(path);
		if (browsingFor === 'storage') {
			storagePathValue = normalizedPath;
		} else if (browsingFor === 'temp') {
			tempPathValue = normalizedPath;
		} else if (browsingFor === 'lish') {
			lishPathValue = normalizedPath;
		} else if (browsingFor === 'lishnet') {
			lishnetPathValue = normalizedPath;
		}
		handleBrowseBack();
	}

	async function handleBrowseBack(): Promise<void> {
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
	function savePort(): void {
		setIncomingPort(parseInt(port) || 9090);
		port = $incomingPort.toString();
	}

	function saveDownloadConnections(): void {
		setMaxDownloadConnections(parseInt(downloadConnections) || 0);
		downloadConnections = $maxDownloadConnections.toString();
	}

	function saveUploadConnections(): void {
		setMaxUploadConnections(parseInt(uploadConnections) || 0);
		uploadConnections = $maxUploadConnections.toString();
	}

	function saveDownloadSpeed(): void {
		setMaxDownloadSpeed(parseInt(downloadSpeed) || 0);
		downloadSpeed = $maxDownloadSpeed.toString();
	}

	function saveUploadSpeed(): void {
		setMaxUploadSpeed(parseInt(uploadSpeed) || 0);
		uploadSpeed = $maxUploadSpeed.toString();
	}

	function saveRelayReservations(): void {
		setMaxRelayReservations(parseInt(relayReservations) || 100);
		relayReservations = $maxRelayReservations.toString();
	}

	function saveAll(): void {
		setStoragePath(storagePathValue);
		setStorageTempPath(tempPathValue);
		setStorageLISHPath(lishPathValue);
		setStorageLISHnetPath(lishnetPathValue);
		savePort();
		saveDownloadConnections();
		saveUploadConnections();
		saveDownloadSpeed();
		saveUploadSpeed();
		saveRelayReservations();
	}

	function handleSave(): void {
		saveAll();
		onBack?.();
	}

	function toggleAllowRelay(): void {
		relay = !relay;
		setAllowRelay(relay);
	}

	function toggleAutoStart(): void {
		autoStart = !autoStart;
		setAutoStartSharing(autoStart);
	}

	// Reset functions
	function resetStoragePath(): void {
		storagePathValue = settingsDefaults?.storage?.downloadPath ?? '';
	}

	function resetTempPath(): void {
		tempPathValue = settingsDefaults?.storage?.tempPath ?? '';
	}

	function resetLISHPath(): void {
		lishPathValue = settingsDefaults?.storage?.lishPath ?? '';
	}

	function resetLISHnetPath(): void {
		lishnetPathValue = settingsDefaults?.storage?.lishnetPath ?? '';
	}

	function resetPort(): void {
		port = String(settingsDefaults?.network?.incomingPort ?? 0);
	}

	function resetDownloadConnections(): void {
		downloadConnections = String(settingsDefaults?.network?.maxDownloadConnections ?? 0);
	}

	function resetUploadConnections(): void {
		uploadConnections = String(settingsDefaults?.network?.maxUploadConnections ?? 0);
	}

	function resetDownloadSpeed(): void {
		downloadSpeed = String(settingsDefaults?.network?.maxDownloadSpeed ?? 0);
	}

	function resetUploadSpeed(): void {
		uploadSpeed = String(settingsDefaults?.network?.maxUploadSpeed ?? 0);
	}

	function resetRelayReservations(): void {
		relayReservations = String(settingsDefaults?.network?.maxRelayReservations ?? 0);
	}

	function scrollToSelected(): void {
		scrollToElement(rowElements, selectedIndex);
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
					if (selectedColumn > 0) {
						selectedColumn--;
						return true;
					}
					return false;
				},
				right() {
					const maxCol = selectedIndex === FIELD_STORAGE_PATH || selectedIndex === FIELD_TEMP_PATH || selectedIndex === FIELD_LISH_PATH || selectedIndex === FIELD_LISHNET_PATH ? 2 : selectedIndex === FIELD_PORT || selectedIndex === FIELD_DOWNLOAD_CONNECTIONS || selectedIndex === FIELD_UPLOAD_CONNECTIONS || selectedIndex === FIELD_DOWNLOAD_SPEED || selectedIndex === FIELD_UPLOAD_SPEED || selectedIndex === FIELD_RELAY_RESERVATIONS ? 1 : selectedIndex === FIELD_BUTTONS ? 1 : 0;
					if (selectedColumn < maxCol) {
						selectedColumn++;
						return true;
					}
					return false;
				},
				confirmDown() {
					if (selectedIndex === FIELD_STORAGE_PATH && selectedColumn === 0) storagePathRef?.focus();
					else if (selectedIndex === FIELD_TEMP_PATH && selectedColumn === 0) tempPathRef?.focus();
					else if (selectedIndex === FIELD_LISH_PATH && selectedColumn === 0) lishPathRef?.focus();
					else if (selectedIndex === FIELD_LISHNET_PATH && selectedColumn === 0) lishnetPathRef?.focus();
					else if (selectedIndex === FIELD_PORT && selectedColumn === 0) portRef?.focus();
					else if (selectedIndex === FIELD_DOWNLOAD_CONNECTIONS && selectedColumn === 0) downloadConnectionsRef?.focus();
					else if (selectedIndex === FIELD_UPLOAD_CONNECTIONS && selectedColumn === 0) uploadConnectionsRef?.focus();
					else if (selectedIndex === FIELD_DOWNLOAD_SPEED && selectedColumn === 0) downloadSpeedRef?.focus();
					else if (selectedIndex === FIELD_UPLOAD_SPEED && selectedColumn === 0) uploadSpeedRef?.focus();
					else if (selectedIndex === FIELD_RELAY_RESERVATIONS && selectedColumn === 0) relayReservationsRef?.focus();
				},
				confirmUp() {
					if (selectedIndex === FIELD_STORAGE_PATH && selectedColumn === 1) openBrowse('storage');
					else if (selectedIndex === FIELD_STORAGE_PATH && selectedColumn === 2) resetStoragePath();
					else if (selectedIndex === FIELD_TEMP_PATH && selectedColumn === 1) openBrowse('temp');
					else if (selectedIndex === FIELD_TEMP_PATH && selectedColumn === 2) resetTempPath();
					else if (selectedIndex === FIELD_LISH_PATH && selectedColumn === 1) openBrowse('lish');
					else if (selectedIndex === FIELD_LISH_PATH && selectedColumn === 2) resetLISHPath();
					else if (selectedIndex === FIELD_LISHNET_PATH && selectedColumn === 1) openBrowse('lishnet');
					else if (selectedIndex === FIELD_LISHNET_PATH && selectedColumn === 2) resetLISHnetPath();
					else if (selectedIndex === FIELD_PORT && selectedColumn === 1) resetPort();
					else if (selectedIndex === FIELD_DOWNLOAD_CONNECTIONS && selectedColumn === 1) resetDownloadConnections();
					else if (selectedIndex === FIELD_UPLOAD_CONNECTIONS && selectedColumn === 1) resetUploadConnections();
					else if (selectedIndex === FIELD_DOWNLOAD_SPEED && selectedColumn === 1) resetDownloadSpeed();
					else if (selectedIndex === FIELD_UPLOAD_SPEED && selectedColumn === 1) resetUploadSpeed();
					else if (selectedIndex === FIELD_RELAY_RESERVATIONS && selectedColumn === 1) resetRelayReservations();
					else if (selectedIndex === FIELD_ALLOW_RELAY) toggleAllowRelay();
					else if (selectedIndex === FIELD_AUTO_START) toggleAutoStart();
					else if (selectedIndex === FIELD_BUTTONS) {
						if (selectedColumn === 0) handleSave();
						else onBack?.();
					}
				},
				confirmCancel() {},
				back() { onBack?.(); },
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

	.row {
		display: flex;
		gap: 1vh;
		align-items: flex-end;
	}
</style>

{#if browsingFor}
	<SettingsStorageBrowse {areaID} {position} initialPath={browsingFor === 'storage' ? $storagePath : browsingFor === 'temp' ? $storageTempPath : browsingFor === 'lish' ? $storageLISHPath : $storageLISHnetPath} onSelect={handleBrowseSelect} onBack={handleBrowseBack} />
{:else}
	<div class="settings">
		<div class="container">
			<!-- Storage paths -->
			<div class="row" bind:this={rowElements[FIELD_STORAGE_PATH]} onmouseenter={() => { activateArea(areaID); selectedIndex = FIELD_STORAGE_PATH; }}>
				<Input bind:this={storagePathRef} bind:value={storagePathValue} label={$t('settings.download.folderDownload')} selected={active && selectedIndex === FIELD_STORAGE_PATH && selectedColumn === 0} flex />
				<Button icon="/img/folder.svg" selected={active && selectedIndex === FIELD_STORAGE_PATH && selectedColumn === 1} onConfirm={() => openBrowse('storage')} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				<Button icon="/img/restart.svg" selected={active && selectedIndex === FIELD_STORAGE_PATH && selectedColumn === 2} onConfirm={resetStoragePath} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row" bind:this={rowElements[FIELD_TEMP_PATH]} onmouseenter={() => { activateArea(areaID); selectedIndex = FIELD_TEMP_PATH; }}>
				<Input bind:this={tempPathRef} bind:value={tempPathValue} label={$t('settings.download.folderTemp')} selected={active && selectedIndex === FIELD_TEMP_PATH && selectedColumn === 0} flex />
				<Button icon="/img/folder.svg" selected={active && selectedIndex === FIELD_TEMP_PATH && selectedColumn === 1} onConfirm={() => openBrowse('temp')} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				<Button icon="/img/restart.svg" selected={active && selectedIndex === FIELD_TEMP_PATH && selectedColumn === 2} onConfirm={resetTempPath} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row" bind:this={rowElements[FIELD_LISH_PATH]} onmouseenter={() => { activateArea(areaID); selectedIndex = FIELD_LISH_PATH; }}>
				<Input bind:this={lishPathRef} bind:value={lishPathValue} label={$t('settings.download.folderLISH')} selected={active && selectedIndex === FIELD_LISH_PATH && selectedColumn === 0} flex />
				<Button icon="/img/folder.svg" selected={active && selectedIndex === FIELD_LISH_PATH && selectedColumn === 1} onConfirm={() => openBrowse('lish')} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				<Button icon="/img/restart.svg" selected={active && selectedIndex === FIELD_LISH_PATH && selectedColumn === 2} onConfirm={resetLISHPath} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row" bind:this={rowElements[FIELD_LISHNET_PATH]} onmouseenter={() => { activateArea(areaID); selectedIndex = FIELD_LISHNET_PATH; }}>
				<Input bind:this={lishnetPathRef} bind:value={lishnetPathValue} label={$t('settings.download.folderLISHnet')} selected={active && selectedIndex === FIELD_LISHNET_PATH && selectedColumn === 0} flex />
				<Button icon="/img/folder.svg" selected={active && selectedIndex === FIELD_LISHNET_PATH && selectedColumn === 1} onConfirm={() => openBrowse('lishnet')} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				<Button icon="/img/restart.svg" selected={active && selectedIndex === FIELD_LISHNET_PATH && selectedColumn === 2} onConfirm={resetLISHnetPath} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<!-- Network settings -->
			<div class="row" bind:this={rowElements[FIELD_PORT]} onmouseenter={() => { activateArea(areaID); selectedIndex = FIELD_PORT; }}>
				<Input bind:this={portRef} bind:value={port} label={$t('settings.download.incomingPort')} type="number" selected={active && selectedIndex === FIELD_PORT && selectedColumn === 0} flex />
				<Button icon="/img/restart.svg" selected={active && selectedIndex === FIELD_PORT && selectedColumn === 1} onConfirm={resetPort} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row" bind:this={rowElements[FIELD_DOWNLOAD_CONNECTIONS]} onmouseenter={() => { activateArea(areaID); selectedIndex = FIELD_DOWNLOAD_CONNECTIONS; }}>
				<Input bind:this={downloadConnectionsRef} bind:value={downloadConnections} label={$t('settings.download.maxDownloadConnections')} type="number" selected={active && selectedIndex === FIELD_DOWNLOAD_CONNECTIONS && selectedColumn === 0} flex />
				<Button icon="/img/restart.svg" selected={active && selectedIndex === FIELD_DOWNLOAD_CONNECTIONS && selectedColumn === 1} onConfirm={resetDownloadConnections} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row" bind:this={rowElements[FIELD_UPLOAD_CONNECTIONS]} onmouseenter={() => { activateArea(areaID); selectedIndex = FIELD_UPLOAD_CONNECTIONS; }}>
				<Input bind:this={uploadConnectionsRef} bind:value={uploadConnections} label={$t('settings.download.maxUploadConnections')} type="number" selected={active && selectedIndex === FIELD_UPLOAD_CONNECTIONS && selectedColumn === 0} flex />
				<Button icon="/img/restart.svg" selected={active && selectedIndex === FIELD_UPLOAD_CONNECTIONS && selectedColumn === 1} onConfirm={resetUploadConnections} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row" bind:this={rowElements[FIELD_DOWNLOAD_SPEED]} onmouseenter={() => { activateArea(areaID); selectedIndex = FIELD_DOWNLOAD_SPEED; }}>
				<Input bind:this={downloadSpeedRef} bind:value={downloadSpeed} label={$t('settings.download.maxDownloadSpeed')} type="number" selected={active && selectedIndex === FIELD_DOWNLOAD_SPEED && selectedColumn === 0} flex />
				<Button icon="/img/restart.svg" selected={active && selectedIndex === FIELD_DOWNLOAD_SPEED && selectedColumn === 1} onConfirm={resetDownloadSpeed} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row" bind:this={rowElements[FIELD_UPLOAD_SPEED]} onmouseenter={() => { activateArea(areaID); selectedIndex = FIELD_UPLOAD_SPEED; }}>
				<Input bind:this={uploadSpeedRef} bind:value={uploadSpeed} label={$t('settings.download.maxUploadSpeed')} type="number" selected={active && selectedIndex === FIELD_UPLOAD_SPEED && selectedColumn === 0} flex />
				<Button icon="/img/restart.svg" selected={active && selectedIndex === FIELD_UPLOAD_SPEED && selectedColumn === 1} onConfirm={resetUploadSpeed} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div bind:this={rowElements[FIELD_ALLOW_RELAY]} onmouseenter={() => { activateArea(areaID); selectedIndex = FIELD_ALLOW_RELAY; }}>
				<SwitchRow label={$t('settings.download.allowRelay') + ':'} checked={relay} selected={active && selectedIndex === FIELD_ALLOW_RELAY} onToggle={toggleAllowRelay} />
			</div>
			<div class="row" bind:this={rowElements[FIELD_RELAY_RESERVATIONS]} onmouseenter={() => { activateArea(areaID); selectedIndex = FIELD_RELAY_RESERVATIONS; }}>
				<Input bind:this={relayReservationsRef} bind:value={relayReservations} label={$t('settings.download.maxRelayReservations')} type="number" selected={active && selectedIndex === FIELD_RELAY_RESERVATIONS && selectedColumn === 0} flex />
				<Button icon="/img/restart.svg" selected={active && selectedIndex === FIELD_RELAY_RESERVATIONS && selectedColumn === 1} onConfirm={resetRelayReservations} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div bind:this={rowElements[FIELD_AUTO_START]} onmouseenter={() => { activateArea(areaID); selectedIndex = FIELD_AUTO_START; }}>
				<SwitchRow label={$t('settings.download.autoStartSharingDefault') + ':'} checked={autoStart} selected={active && selectedIndex === FIELD_AUTO_START} onToggle={toggleAutoStart} />
			</div>
		</div>
		<ButtonBar justify="center">
			<Button icon="/img/save.svg" label={$t('common.save')} selected={active && selectedIndex === FIELD_BUTTONS && selectedColumn === 0} onConfirm={handleSave} />
			<Button icon="/img/back.svg" label={$t('common.back')} selected={active && selectedIndex === FIELD_BUTTONS && selectedColumn === 1} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
