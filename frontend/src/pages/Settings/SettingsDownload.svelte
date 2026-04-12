<script lang="ts">
	import { tick } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { storagePath, storageTempPath, storageLISHPath, storageLISHnetPath, setStoragePath, setStorageTempPath, setStorageLISHPath, setStorageLISHnetPath, incomingPort, maxDownloadConnections, maxUploadConnections, maxDownloadSpeed, maxUploadSpeed, allowRelay, maxRelayReservations, autoStartSharing, autoStartDownloading, autoErrorRecovery, setIncomingPort, setMaxDownloadConnections, setMaxUploadConnections, setMaxDownloadSpeed, setMaxUploadSpeed, setAllowRelay, setMaxRelayReservations, setAutoStartSharing, setAutoStartDownloading, setAutoErrorRecovery, settingsDefaults } from '../../scripts/settings.ts';
	import { normalizePath } from '../../scripts/utils.ts';
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
	let removeBackHandler: (() => void) | null = null;
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
	let autoStartDl = $state($autoStartDownloading);
	let autoRecovery = $state($autoErrorRecovery);

	// Browse functions
	function openBrowse(type: 'storage' | 'temp' | 'lish' | 'lishnet'): void {
		browsingFor = type;
		navHandle.pause();
		const labels = {
			storage: $t('settings.download.directoryDownload'),
			temp: $t('settings.download.directoryTemp'),
			lish: $t('settings.download.directoryLISH'),
			lishnet: $t('settings.download.directoryLISHnet'),
		};
		pushBreadcrumb(labels[type]);
		removeBackHandler = pushBackHandler(handleBrowseBack);
	}

	function handleBrowseSelect(path: string): void {
		const normalizedPath = normalizePath(path);
		if (browsingFor === 'storage') storagePathValue = normalizedPath;
		else if (browsingFor === 'temp') tempPathValue = normalizedPath;
		else if (browsingFor === 'lish') lishPathValue = normalizedPath;
		else if (browsingFor === 'lishnet') lishnetPathValue = normalizedPath;
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
		navHandle.resume();
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

	function toggleAutoStartDl(): void {
		autoStartDl = !autoStartDl;
		setAutoStartDownloading(autoStartDl);
	}

	function toggleAutoRecovery(): void {
		autoRecovery = !autoRecovery;
		setAutoErrorRecovery(autoRecovery);
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

	const navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));
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
			<div class="row">
				<Input bind:value={storagePathValue} label={$t('settings.download.directoryDownload')} position={[0, 0]} flex />
				<Button icon="/img/directory.svg" position={[1, 0]} onConfirm={() => openBrowse('storage')} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				<Button icon="/img/restart.svg" position={[2, 0]} onConfirm={resetStoragePath} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row">
				<Input bind:value={tempPathValue} label={$t('settings.download.directoryTemp')} position={[0, 1]} flex />
				<Button icon="/img/directory.svg" position={[1, 1]} onConfirm={() => openBrowse('temp')} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				<Button icon="/img/restart.svg" position={[2, 1]} onConfirm={resetTempPath} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row">
				<Input bind:value={lishPathValue} label={$t('settings.download.directoryLISH')} position={[0, 2]} flex />
				<Button icon="/img/directory.svg" position={[1, 2]} onConfirm={() => openBrowse('lish')} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				<Button icon="/img/restart.svg" position={[2, 2]} onConfirm={resetLISHPath} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row">
				<Input bind:value={lishnetPathValue} label={$t('settings.download.directoryLISHnet')} position={[0, 3]} flex />
				<Button icon="/img/directory.svg" position={[1, 3]} onConfirm={() => openBrowse('lishnet')} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				<Button icon="/img/restart.svg" position={[2, 3]} onConfirm={resetLISHnetPath} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row">
				<Input bind:value={port} label={$t('settings.download.incomingPort')} type="number" position={[0, 4]} flex />
				<Button icon="/img/restart.svg" position={[1, 4]} onConfirm={resetPort} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row">
				<Input bind:value={downloadConnections} label={$t('settings.download.maxDownloadConnections')} type="number" position={[0, 5]} flex />
				<Button icon="/img/restart.svg" position={[1, 5]} onConfirm={resetDownloadConnections} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row">
				<Input bind:value={uploadConnections} label={$t('settings.download.maxUploadConnections')} type="number" position={[0, 6]} flex />
				<Button icon="/img/restart.svg" position={[1, 6]} onConfirm={resetUploadConnections} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row">
				<Input bind:value={downloadSpeed} label={$t('settings.download.maxDownloadSpeed')} type="number" min={0} position={[0, 7]} flex />
				<Button icon="/img/restart.svg" position={[1, 7]} onConfirm={resetDownloadSpeed} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<div class="row">
				<Input bind:value={uploadSpeed} label={$t('settings.download.maxUploadSpeed')} type="number" min={0} position={[0, 8]} flex />
				<Button icon="/img/restart.svg" position={[1, 8]} onConfirm={resetUploadSpeed} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<SwitchRow label={$t('settings.download.allowRelay') + ':'} checked={relay} position={[0, 9]} onToggle={toggleAllowRelay} />
			<div class="row">
				<Input bind:value={relayReservations} label={$t('settings.download.maxRelayReservations')} type="number" position={[0, 10]} flex />
				<Button icon="/img/restart.svg" position={[1, 10]} onConfirm={resetRelayReservations} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<SwitchRow label={$t('settings.download.autoStartSharingDefault') + ':'} checked={autoStart} position={[0, 11]} onToggle={toggleAutoStart} />
			<SwitchRow label={$t('settings.download.autoStartDownloadingDefault') + ':'} checked={autoStartDl} position={[0, 12]} onToggle={toggleAutoStartDl} />
			<SwitchRow label={$t('settings.download.autoErrorRecovery') + ':'} checked={autoRecovery} position={[0, 13]} onToggle={toggleAutoRecovery} />
		</div>
		<ButtonBar justify="center">
			<Button icon="/img/save.svg" label={$t('common.save')} position={[0, 14]} onConfirm={handleSave} />
			<Button icon="/img/back.svg" label={$t('common.back')} position={[1, 14]} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
