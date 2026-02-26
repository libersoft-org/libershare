import { writable, type Writable } from 'svelte/store';
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
export const footerVisible = writable(true);
export const footerPosition = writable<FooterPosition>('right');
export const footerWidgetVisibility = writable<Record<FooterWidget, boolean>>(defaultWidgetVisibility);
export const timeFormat = writable(true);
export const showSeconds = writable(false);
export const storagePath = writable('');
export const storageTempPath = writable('');
export const storageLishPath = writable('');
export const storageLishnetPath = writable('');
export const incomingPort = writable(0);
export const maxDownloadConnections = writable(0);
export const maxUploadConnections = writable(0);
export const maxDownloadSpeed = writable(0);
export const maxUploadSpeed = writable(0);
export const allowRelay = writable(true);
export const maxRelayReservations = writable(0);
export const autoStartSharing = writable(true);
export const autoStartOnBoot = writable(true);
export const showInTray = writable(true);
export const minimizeToTray = writable(true);
export const defaultMinifyJson = writable(false);
export const defaultCompressGzip = writable(false);

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
		const [settings, defaults] = await Promise.all([api.settings.getAll(), api.settings.getDefaults()]);
		settingsDefaults = defaults;

		// Language
		if (settings.language && languages.some(l => l.id === settings.language)) {
			currentLanguage.set(settings.language);
		}

		// UI
		cursorSize.set(settings.ui.cursorSize);
		footerVisible.set(settings.ui.footerVisible);
		footerPosition.set(settings.ui.footerPosition);
		footerWidgetVisibility.set(settings.ui.footerWidgets);
		timeFormat.set(settings.ui.timeFormat24h);
		showSeconds.set(settings.ui.showSeconds);

		// Audio
		audioEnabled.set(settings.audio.enabled);
		volume.set(settings.audio.volume);

		// Storage
		storagePath.set(settings.storage.downloadPath);
		storageTempPath.set(settings.storage.tempPath);
		storageLishPath.set(settings.storage.lishPath);
		storageLishnetPath.set(settings.storage.lishnetPath);

		// Network
		incomingPort.set(settings.network.incomingPort);
		maxDownloadConnections.set(settings.network.maxDownloadConnections);
		maxUploadConnections.set(settings.network.maxUploadConnections);
		maxDownloadSpeed.set(settings.network.maxDownloadSpeed);
		maxUploadSpeed.set(settings.network.maxUploadSpeed);
		allowRelay.set(settings.network.allowRelay);
		maxRelayReservations.set(settings.network.maxRelayReservations);
		autoStartSharing.set(settings.network.autoStartSharing);

		// System
		autoStartOnBoot.set(settings.system.autoStartOnBoot);
		showInTray.set(settings.system.showInTray);
		minimizeToTray.set(settings.system.minimizeToTray);

		// Export
		defaultMinifyJson.set(settings.export.minifyJson);
		defaultCompressGzip.set(settings.export.compressGzip);

		// Input
		inputInitialDelay.set(settings.input.initialDelay);
		inputRepeatDelay.set(settings.input.repeatDelay);
		gamepadDeadzone.set(settings.input.gamepadDeadzone);

		console.log('[Settings] Loaded from backend');
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

export function setStorageLishPath(path: string): void {
	updateSetting(storageLishPath, 'storage.lishPath', path);
}

export function setStorageLishnetPath(path: string): void {
	updateSetting(storageLishnetPath, 'storage.lishnetPath', path);
}

export function setIncomingPort(value: number): void {
	const clampedValue = Math.max(1, Math.min(65535, value || DEFAULT_INCOMING_PORT));
	updateSetting(incomingPort, 'network.incomingPort', clampedValue);
}

export function setMaxDownloadConnections(value: number): void {
	const clampedValue = Math.max(0, value || 0);
	updateSetting(maxDownloadConnections, 'network.maxDownloadConnections', clampedValue);
}

export function setMaxUploadConnections(value: number): void {
	const clampedValue = Math.max(0, value || 0);
	updateSetting(maxUploadConnections, 'network.maxUploadConnections', clampedValue);
}

export function setMaxDownloadSpeed(value: number): void {
	const clampedValue = Math.max(0, value || 0);
	updateSetting(maxDownloadSpeed, 'network.maxDownloadSpeed', clampedValue);
}

export function setMaxUploadSpeed(value: number): void {
	const clampedValue = Math.max(0, value || 0);
	updateSetting(maxUploadSpeed, 'network.maxUploadSpeed', clampedValue);
}

export function setAllowRelay(enabled: boolean): void {
	updateSetting(allowRelay, 'network.allowRelay', enabled);
}

export function setMaxRelayReservations(value: number): void {
	const clampedValue = Math.max(0, value || 0);
	updateSetting(maxRelayReservations, 'network.maxRelayReservations', clampedValue);
}

export function setAutoStartSharing(enabled: boolean): void {
	updateSetting(autoStartSharing, 'network.autoStartSharing', enabled);
}

export function setAutoStartOnBoot(enabled: boolean): void {
	updateSetting(autoStartOnBoot, 'system.autoStartOnBoot', enabled);
}

export function setShowInTray(enabled: boolean): void {
	updateSetting(showInTray, 'system.showInTray', enabled);
	// If disabling tray, also disable minimize to tray
	if (!enabled) {
		updateSetting(minimizeToTray, 'system.minimizeToTray', false);
	}
}

export function setMinimizeToTray(enabled: boolean): void {
	updateSetting(minimizeToTray, 'system.minimizeToTray', enabled);
}

export function setDefaultMinifyJson(enabled: boolean): void {
	updateSetting(defaultMinifyJson, 'export.minifyJson', enabled);
}

export function setDefaultCompressGzip(enabled: boolean): void {
	updateSetting(defaultCompressGzip, 'export.compressGzip', enabled);
}

// Volume helpers
export function increaseVolume(): void {
	volume.update(v => {
		const newVal = Math.min(100, v + 1);
		api.settings.set('audio.volume', newVal).catch((err: unknown) => console.error('[Settings] Error saving volume:', err));
		return newVal;
	});
}

export function decreaseVolume(): void {
	volume.update(v => {
		const newVal = Math.max(0, v - 1);
		api.settings.set('audio.volume', newVal).catch((err: unknown) => console.error('[Settings] Error saving volume:', err));
		return newVal;
	});
}
