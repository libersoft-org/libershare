import { get, writable, type Writable } from 'svelte/store';
import { api } from './api.ts';
import { defaultWidgetVisibility, type FooterPosition, type FooterWidget } from './footerWidgets.ts';
import { currentLanguage, languages } from './language.ts';
// Types
export type CursorSize = 'small' | 'medium' | 'large';
export const cursorSizes: Record<CursorSize, string> = {
	small: '2.5vh',
	medium: '5vh',
	large: '7.5vh',
};
// Defaults
const DEFAULT_INCOMING_PORT = 9090;
// Settings stores (will be loaded from backend)
export const audioEnabled = writable(true);
export const cursorSize = writable<CursorSize>('medium');
export const inputInitialDelay = writable(400);
export const inputRepeatDelay = writable(150);
export const gamepadDeadzone = writable(0.5);
export const volume = writable(50);
// Whether the OS exposes a controllable audio device. False on headless/device-less
// systems — the footer widget then shows an "unavailable" state instead of a level.
export const volumeAvailable = writable(true);
// False until the first live getVolume settles. Keeps the widget from briefly
// painting the persisted value as if it were the OS state on refresh (flicker).
export const volumeKnown = writable(false);
export const footerVisible = writable(true);
export const footerPosition = writable<FooterPosition>('right');
export const footerWidgetVisibility = writable<Record<FooterWidget, boolean>>(defaultWidgetVisibility);
export const timeFormat = writable(true);
export const showSeconds = writable(false);
export const storagePath = writable('');
export const storageTempPath = writable('');
export const storageLISHPath = writable('');
export const storageLISHnetPath = writable('');
export const storageBackupPath = writable('');
export const incomingPort = writable(0);
export const maxDownloadPeersPerLISH = writable(0);
export const maxUploadPeersPerLISH = writable(0);
export const maxDownloadSpeed = writable(0);
export const maxUploadSpeed = writable(0);
export const maxChunkSize = writable(0);
export const maxMessageSize = writable(0);
export const allowRelay = writable(true);
export const maxRelayReservations = writable(0);
export const useRelayClients = writable(true);
export const maxRelayClients = writable(5);
export const autoStartSharing = writable(true);
export const autoStartDownloading = writable(true);
export const autoErrorRecovery = writable(true);
export const autoConnectNewNetworks = writable(true);
export const mdnsEnabled = writable(true);
export const mdnsInterval = writable(10000);
export const upnpEnabled = writable(true);
export const searchTimeout = writable(30000);
export const autoStartOnBoot = writable(true);
export const showInTray = writable(true);
export const minimizeToTray = writable(true);
export const notificationTimeout = writable(5);
export const defaultMinifyJSON = writable(false);
export const defaultCompress = writable(false);
export const defaultCompressionAlgorithm = writable('gzip');

/**
 * Master switch for mouse support. When false, MouseManager skips listener
 * registration entirely — no cursor tracking, no click/hover delegation, no
 * right-click-as-back. Defaults to true; UI toggle can be added later.
 */
export const mouseSupportEnabled = writable(true);

// Cached defaults from backend (loaded once)
export let settingsDefaults: any = null;

// Helper to update store and save to backend
async function updateSetting<T>(store: Writable<T>, path: string, value: T): Promise<void> {
	store.set(value);
	try {
		await api.settings.set(path, value);
	} catch (error) {
		console.error(`[Settings] Error saving ${path}:`, error);
	}
}

// Load all settings from backend
export async function loadSettings(): Promise<void> {
	try {
		const [settings, defaults] = await Promise.all([api.settings.list(), api.settings.getDefaults()]);
		settingsDefaults = defaults;

		// Language
		if (settings.language && languages.some(l => l.id === settings.language)) currentLanguage.set(settings.language);

		// UI
		cursorSize.set(settings.ui.cursorSize);
		footerVisible.set(settings.ui.footerVisible);
		footerPosition.set(settings.ui.footerPosition);
		footerWidgetVisibility.set({ ...defaultWidgetVisibility, ...settings.ui.footerWidgets });
		timeFormat.set(settings.ui.timeFormat24h);
		showSeconds.set(settings.ui.showSeconds);

		// Audio
		audioEnabled.set(settings.audio.enabled);
		volume.set(settings.audio.volume);
		// Reconcile with the OS: use the live volume when a device is present,
		// otherwise flag it unavailable so the widget shows no fabricated level.
		// Fire-and-forget — a wedged mixer helper (backend read can take seconds)
		// must not hold loadSettings() and with it the rest of app initialization;
		// the widget renders the persisted value until the live fetch settles.
		void api
			.call<{ volume: number | null; available: boolean }>('system.getVolume')
			.then(status => {
				volumeAvailable.set(status.available);
				if (status.available && status.volume !== null) volume.set(status.volume);
			})
			.catch(() => {
				// Leave the persisted value on error; availability stays as-is.
			})
			.finally(() => {
				// First live fetch settled — the widget may now render the real state.
				volumeKnown.set(true);
			});
		// Keep the UI in sync when the volume changes on the OS side.
		subscribeVolumeChanges();

		// Storage
		storagePath.set(settings.storage.downloadPath);
		storageTempPath.set(settings.storage.tempPath);
		storageLISHPath.set(settings.storage.lishPath);
		storageLISHnetPath.set(settings.storage.lishnetPath);
		storageBackupPath.set(settings.storage.backupPath ?? '');

		// Network
		incomingPort.set(settings.network.incomingPort);
		maxDownloadPeersPerLISH.set(settings.network.maxDownloadPeersPerLISH);
		maxUploadPeersPerLISH.set(settings.network.maxUploadPeersPerLISH);
		maxDownloadSpeed.set(settings.network.maxDownloadSpeed);
		maxUploadSpeed.set(settings.network.maxUploadSpeed);
		maxChunkSize.set(settings.network.maxChunkSize);
		maxMessageSize.set(settings.network.maxMessageSize);
		allowRelay.set(settings.network.allowRelay);
		maxRelayReservations.set(settings.network.maxRelayReservations);
		useRelayClients.set(settings.network.useRelayClients ?? true);
		maxRelayClients.set(settings.network.maxRelayClients ?? 5);
		autoStartSharing.set(settings.network.autoStartSharing);
		autoStartDownloading.set(settings.network.autoStartDownloading);
		autoErrorRecovery.set(settings.network.autoErrorRecovery ?? true);
		autoConnectNewNetworks.set(settings.network.autoConnectNewNetworks ?? true);
		mdnsEnabled.set(settings.network.mdnsEnabled ?? true);
		mdnsInterval.set(settings.network.mdnsInterval ?? 10000);
		upnpEnabled.set(settings.network.upnpEnabled ?? false);
		searchTimeout.set(settings.network.searchTimeout ?? 30000);

		// System
		autoStartOnBoot.set(settings.system.autoStartOnBoot);
		showInTray.set(settings.system.showInTray);
		minimizeToTray.set(settings.system.minimizeToTray);
		notificationTimeout.set(settings.system.notificationTimeout);

		// Export
		defaultMinifyJSON.set(settings.export.minifyJSON);
		defaultCompress.set(settings.export.compress);
		defaultCompressionAlgorithm.set(settings.export.compressionAlgorithm);

		// Input
		inputInitialDelay.set(settings.input.initialDelay);
		inputRepeatDelay.set(settings.input.repeatDelay);
		gamepadDeadzone.set(settings.input.gamepadDeadzone);
	} catch (error) {
		console.error('[Settings] Error loading settings:', error);
	}
}

// Setters
export function setAudioEnabled(enabled: boolean): void {
	updateSetting(audioEnabled, 'audio.enabled', enabled);
}

export function setCursorSize(size: CursorSize): void {
	updateSetting(cursorSize, 'ui.cursorSize', size);
}

export function setFooterVisible(visible: boolean): void {
	updateSetting(footerVisible, 'ui.footerVisible', visible);
}

export function setFooterPosition(position: FooterPosition): void {
	updateSetting(footerPosition, 'ui.footerPosition', position);
}

export function setFooterWidgetVisibility(widget: FooterWidget, visible: boolean): void {
	footerWidgetVisibility.update(current => {
		const updated = { ...current, [widget]: visible };
		api.settings.set('ui.footerWidgets', updated).catch((err: unknown) => console.error('[Settings] Error saving footerWidgets:', err));
		return updated;
	});
}

export function setTimeFormat(enabled: boolean): void {
	updateSetting(timeFormat, 'ui.timeFormat24h', enabled);
}

export function setShowSeconds(enabled: boolean): void {
	updateSetting(showSeconds, 'ui.showSeconds', enabled);
}

export function setStoragePath(path: string): void {
	updateSetting(storagePath, 'storage.downloadPath', path);
}

export function setStorageTempPath(path: string): void {
	updateSetting(storageTempPath, 'storage.tempPath', path);
}

export function setStorageLISHPath(path: string): void {
	updateSetting(storageLISHPath, 'storage.lishPath', path);
}

export function setStorageLISHnetPath(path: string): void {
	updateSetting(storageLISHnetPath, 'storage.lishnetPath', path);
}

export function setStorageBackupPath(path: string): void {
	updateSetting(storageBackupPath, 'storage.backupPath', path);
}

export function setIncomingPort(value: number): void {
	const clampedValue = Math.max(1, Math.min(65535, value || DEFAULT_INCOMING_PORT));
	updateSetting(incomingPort, 'network.incomingPort', clampedValue);
}

export function setMaxDownloadPeersPerLISH(value: number): void {
	const clampedValue = Math.max(0, value || 0);
	updateSetting(maxDownloadPeersPerLISH, 'network.maxDownloadPeersPerLISH', clampedValue);
}

export function setMaxUploadPeersPerLISH(value: number): void {
	const clampedValue = Math.max(0, value || 0);
	updateSetting(maxUploadPeersPerLISH, 'network.maxUploadPeersPerLISH', clampedValue);
}

export function setMaxDownloadSpeed(value: number): void {
	const clampedValue = Math.max(0, value || 0);
	updateSetting(maxDownloadSpeed, 'network.maxDownloadSpeed', clampedValue);
}

export function setMaxUploadSpeed(value: number): void {
	const clampedValue = Math.max(0, value || 0);
	updateSetting(maxUploadSpeed, 'network.maxUploadSpeed', clampedValue);
}

export function setMaxChunkSize(value: number): void {
	const clampedValue = Math.max(1, value || 1);
	updateSetting(maxChunkSize, 'network.maxChunkSize', clampedValue);
}

export function setMaxMessageSize(value: number): void {
	const clampedValue = Math.max(1, value || 1);
	updateSetting(maxMessageSize, 'network.maxMessageSize', clampedValue);
}

export function setAllowRelay(enabled: boolean): void {
	updateSetting(allowRelay, 'network.allowRelay', enabled);
}

export function setMaxRelayReservations(value: number): void {
	const clampedValue = Math.max(0, value || 0);
	updateSetting(maxRelayReservations, 'network.maxRelayReservations', clampedValue);
}

export function setUseRelayClients(enabled: boolean): void {
	updateSetting(useRelayClients, 'network.useRelayClients', enabled);
}

export function setMaxRelayClients(value: number): void {
	// Hard upper bound mirrors network-config.ts cap (20). Each /p2p-circuit slot
	// adds Multiaddr churn on relay reservation refresh, so silently clamp here.
	const clampedValue = Math.max(1, Math.min(20, value || 5));
	updateSetting(maxRelayClients, 'network.maxRelayClients', clampedValue);
}

export function setAutoStartSharing(enabled: boolean): void {
	updateSetting(autoStartSharing, 'network.autoStartSharing', enabled);
}

export function setAutoStartDownloading(enabled: boolean): void {
	updateSetting(autoStartDownloading, 'network.autoStartDownloading', enabled);
}

export function setAutoConnectNewNetworks(enabled: boolean): void {
	updateSetting(autoConnectNewNetworks, 'network.autoConnectNewNetworks', enabled);
}

export function setAutoErrorRecovery(enabled: boolean): void {
	updateSetting(autoErrorRecovery, 'network.autoErrorRecovery', enabled);
}

export function setMdnsEnabled(enabled: boolean): void {
	updateSetting(mdnsEnabled, 'network.mdnsEnabled', enabled);
}

export function setMdnsInterval(value: number): void {
	const clampedValue = Math.max(1000, Math.min(600000, value || 10000));
	updateSetting(mdnsInterval, 'network.mdnsInterval', clampedValue);
}

export function setUpnpEnabled(enabled: boolean): void {
	updateSetting(upnpEnabled, 'network.upnpEnabled', enabled);
}

export function setAutoStartOnBoot(enabled: boolean): void {
	updateSetting(autoStartOnBoot, 'system.autoStartOnBoot', enabled);
}

export function setShowInTray(enabled: boolean): void {
	updateSetting(showInTray, 'system.showInTray', enabled);
	// If disabling tray, also disable minimize to tray
	if (!enabled) updateSetting(minimizeToTray, 'system.minimizeToTray', false);
}

export function setMinimizeToTray(enabled: boolean): void {
	updateSetting(minimizeToTray, 'system.minimizeToTray', enabled);
}

export function setNotificationTimeout(seconds: number): void {
	updateSetting(notificationTimeout, 'system.notificationTimeout', Math.max(0, seconds));
}

export function setDefaultMinifyJSON(enabled: boolean): void {
	updateSetting(defaultMinifyJSON, 'export.minifyJSON', enabled);
}

export function setDefaultCompress(enabled: boolean): void {
	updateSetting(defaultCompress, 'export.compress', enabled);
}

export function setDefaultCompressionAlgorithm(algorithm: string): void {
	updateSetting(defaultCompressionAlgorithm, 'export.compressionAlgorithm', algorithm);
}

// Volume helpers. The +/- controls update the local store immediately (drives
// the footer widget and local sound cues) and push the value to the backend,
// which persists it and sets the OS master volume. The backend call is debounced
// so holding a repeat key/button down does not spam the WebSocket.
let volumeSyncTimer: ReturnType<typeof setTimeout> | undefined;
// Timestamp of the last local +/- change. Used to hold back OS→FE volume events
// that arrive while the user is actively adjusting, so their in-progress value
// is not clobbered by a slightly stale poll.
let lastLocalVolumeChange = 0;
/** How long after a local +/- press incoming OS volume events are deferred instead of applied. */
const LOCAL_EDIT_GUARD_MS = 1000;
// The newest OS-side level that arrived inside the guard window — replayed once
// the window expires (the backend suppresses its echo, so a dropped event would
// otherwise never be re-delivered and this client would stay stale).
let deferredVolume: number | null = null;
let deferredVolumeTimer: ReturnType<typeof setTimeout> | undefined;

function syncVolumeToBackend(value: number): void {
	lastLocalVolumeChange = Date.now();
	// A newer local edit supersedes any OS-side level captured before it — the
	// backend write that follows will leave the mixer on the local value.
	deferredVolume = null;
	clearTimeout(volumeSyncTimer);
	volumeSyncTimer = setTimeout(() => {
		// The backend persists the preference even with no audio device; we refresh
		// availability from its answer and never surface a per-keystroke error.
		api
			.call<{ success: boolean; available: boolean }>('system.setVolume', { volume: value })
			.then(res => volumeAvailable.set(res.available))
			.catch((err: unknown) => console.error('[Settings] Error saving volume:', err));
	}, 150);
}

export function increaseVolume(): void {
	// Until the live OS level is known the store holds the persisted value —
	// adjusting from it would yank the mixer away from its actual current level.
	if (!get(volumeKnown)) return;
	volume.update(v => {
		const newVal = Math.min(100, v + 1);
		syncVolumeToBackend(newVal);
		return newVal;
	});
}

export function decreaseVolume(): void {
	if (!get(volumeKnown)) return; // see increaseVolume — no adjusting from a stale level
	volume.update(v => {
		const newVal = Math.max(0, v - 1);
		syncVolumeToBackend(newVal);
		return newVal;
	});
}

// Subscribe once to OS→FE volume changes (external tray/media-key adjustments or
// a device being plugged/unplugged). Purely reflects backend state — never calls
// setVolume back, so there is no feedback loop.
let volumeChangeSubscribed = false;
function subscribeVolumeChanges(): void {
	if (!volumeChangeSubscribed) {
		volumeChangeSubscribed = true;
		api.on('system:volumeChanged', (data: { volume: number | null; available: boolean }) => {
			// Availability (device plug/unplug) always applies; the level is held
			// back while the user is mid-adjustment so a stale poll cannot fight
			// their input — but deferred, not dropped, or this client would keep
			// showing its local value forever (the backend suppresses the echo).
			volumeAvailable.set(data.available);
			if (!data.available || data.volume === null) return;
			const remaining = LOCAL_EDIT_GUARD_MS - (Date.now() - lastLocalVolumeChange);
			if (remaining <= 0) {
				// A newer event supersedes any still-pending deferred level — drop it,
				// or its timer would replay the stale value moments after this one.
				deferredVolume = null;
				clearTimeout(deferredVolumeTimer);
				volume.set(data.volume);
				return;
			}
			deferredVolume = data.volume;
			clearTimeout(deferredVolumeTimer);
			deferredVolumeTimer = setTimeout(() => {
				// Only replay when no newer local edit re-armed the guard meanwhile.
				if (deferredVolume !== null && Date.now() - lastLocalVolumeChange >= LOCAL_EDIT_GUARD_MS) {
					volume.set(deferredVolume);
					deferredVolume = null;
				}
			}, remaining + 50);
		});
	}
	api.subscribe('system:volumeChanged').catch(() => {});
}
