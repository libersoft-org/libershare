import { writable } from 'svelte/store';
import { getStorageValue, setStorageValue } from './localStorage.ts';
import { defaultWidgetVisibility, type FooterPosition, type FooterWidget } from './footerWidgets.ts';
// Audio settings
const storedAudio = getStorageValue<boolean>('audio', true);
export const audioEnabled = writable(storedAudio);
// Cursor size settings
export type CursorSize = 'small' | 'medium' | 'large';
export const cursorSizes: Record<CursorSize, string> = {
	small: '2.5vh',
	medium: '5vh',
	large: '7.5vh',
};
const storedCursorSize = getStorageValue<CursorSize>('cursorSize', 'medium');
export const cursorSize = writable(storedCursorSize);
// Input timing settings
export const inputInitialDelay = writable(400); // ms before repeat starts
export const inputRepeatDelay = writable(150); // ms between repeats (4 items per second)
// Gamepad settings
export const gamepadDeadzone = writable(0.5);
// Volume settings (will be replaced with system volume later)
export const volume = writable(50);

export function increaseVolume(): void {
	volume.update(v => Math.min(100, v + 1));
}

export function decreaseVolume(): void {
	volume.update(v => Math.max(0, v - 1));
}

export function setAudioEnabled(enabled: boolean): void {
	audioEnabled.set(enabled);
	setStorageValue('audio', enabled);
}

export function setCursorSize(size: CursorSize): void {
	cursorSize.set(size);
	setStorageValue('cursorSize', size);
}

// Footer visibility settings
const storedFooterVisible = getStorageValue<boolean>('footerVisible', true);
export const footerVisible = writable(storedFooterVisible);

export function setFooterVisible(visible: boolean): void {
	footerVisible.set(visible);
	setStorageValue('footerVisible', visible);
}

const storedFooterPosition = getStorageValue<FooterPosition>('footerPosition', 'right');
export const footerPosition = writable(storedFooterPosition);

export function setFooterPosition(position: FooterPosition): void {
	footerPosition.set(position);
	setStorageValue('footerPosition', position);
}

const storedWidgetVisibility = getStorageValue<Record<FooterWidget, boolean>>('footerWidgetVisibility', defaultWidgetVisibility);
export const footerWidgetVisibility = writable(storedWidgetVisibility);

export function setFooterWidgetVisibility(widget: FooterWidget, visible: boolean): void {
	footerWidgetVisibility.update(current => {
		const updated = { ...current, [widget]: visible };
		setStorageValue('footerWidgetVisibility', updated);
		return updated;
	});
}

// Time settings
const storedTimeFormat = getStorageValue<boolean>('timeFormat', true);
export const timeFormat = writable(storedTimeFormat);

export function setTimeFormat(enabled: boolean): void {
	timeFormat.set(enabled);
	setStorageValue('timeFormat', enabled);
}

const storedShowSeconds = getStorageValue<boolean>('showSeconds', false);
export const showSeconds = writable(storedShowSeconds);

export function setShowSeconds(enabled: boolean): void {
	showSeconds.set(enabled);
	setStorageValue('showSeconds', enabled);
}

// Storage path settings
export const DEFAULT_STORAGE_PATH = '~/libershare/download/';
const storedStoragePath = getStorageValue<string>('storagePath', DEFAULT_STORAGE_PATH);
export const storagePath = writable(storedStoragePath);

export function setStoragePath(path: string): void {
	storagePath.set(path);
	setStorageValue('storagePath', path);
}

export const DEFAULT_STORAGE_TEMP_PATH = '~/libershare/temp/';
const storedStorageTempPath = getStorageValue<string>('storageTempPath', DEFAULT_STORAGE_TEMP_PATH);
export const storageTempPath = writable(storedStorageTempPath);

export function setStorageTempPath(path: string): void {
	storageTempPath.set(path);
	setStorageValue('storageTempPath', path);
}

export const DEFAULT_STORAGE_LISH_PATH = '~/libershare/lish/';
const storedStorageLishPath = getStorageValue<string>('storageLishPath', DEFAULT_STORAGE_LISH_PATH);
export const storageLishPath = writable(storedStorageLishPath);

export function setStorageLishPath(path: string): void {
	storageLishPath.set(path);
	setStorageValue('storageLishPath', path);
}

export const DEFAULT_STORAGE_LISHNET_PATH = '~/libershare/lishnet/';
const storedStorageLishnetPath = getStorageValue<string>('storageLishnetPath', DEFAULT_STORAGE_LISHNET_PATH);
export const storageLishnetPath = writable(storedStorageLishnetPath);

export function setStorageLishnetPath(path: string): void {
	storageLishnetPath.set(path);
	setStorageValue('storageLishnetPath', path);
}

// Sharing settings
export const DEFAULT_INCOMING_PORT = 9090;
const storedIncomingPort = getStorageValue<number>('incomingPort', DEFAULT_INCOMING_PORT);
export const incomingPort = writable(storedIncomingPort);

export function setIncomingPort(value: number): void {
	const clampedValue = Math.max(1, Math.min(65535, value || DEFAULT_INCOMING_PORT));
	incomingPort.set(clampedValue);
	setStorageValue('incomingPort', clampedValue);
}

export const DEFAULT_MAX_DOWNLOAD_CONNECTIONS = 200;
const storedMaxDownloadConnections = getStorageValue<number>('maxDownloadConnections', DEFAULT_MAX_DOWNLOAD_CONNECTIONS);
export const maxDownloadConnections = writable(storedMaxDownloadConnections);

export function setMaxDownloadConnections(value: number): void {
	const clampedValue = Math.max(0, value || 0);
	maxDownloadConnections.set(clampedValue);
	setStorageValue('maxDownloadConnections', clampedValue);
}

export const DEFAULT_MAX_UPLOAD_CONNECTIONS = 200;
const storedMaxUploadConnections = getStorageValue<number>('maxUploadConnections', DEFAULT_MAX_UPLOAD_CONNECTIONS);
export const maxUploadConnections = writable(storedMaxUploadConnections);

export function setMaxUploadConnections(value: number): void {
	const clampedValue = Math.max(0, value || 0);
	maxUploadConnections.set(clampedValue);
	setStorageValue('maxUploadConnections', clampedValue);
}

export const DEFAULT_MAX_DOWNLOAD_SPEED = 0;
const storedMaxDownloadSpeed = getStorageValue<number>('maxDownloadSpeed', DEFAULT_MAX_DOWNLOAD_SPEED);
export const maxDownloadSpeed = writable(storedMaxDownloadSpeed);

export function setMaxDownloadSpeed(value: number): void {
	const clampedValue = Math.max(0, value || 0);
	maxDownloadSpeed.set(clampedValue);
	setStorageValue('maxDownloadSpeed', clampedValue);
}

export const DEFAULT_MAX_UPLOAD_SPEED = 0;
const storedMaxUploadSpeed = getStorageValue<number>('maxUploadSpeed', DEFAULT_MAX_UPLOAD_SPEED);
export const maxUploadSpeed = writable(storedMaxUploadSpeed);

export function setMaxUploadSpeed(value: number): void {
	const clampedValue = Math.max(0, value || 0);
	maxUploadSpeed.set(clampedValue);
	setStorageValue('maxUploadSpeed', clampedValue);
}

export const DEFAULT_AUTO_START_SHARING = true;
const storedAutoStartSharing = getStorageValue<boolean>('autoStartSharing', DEFAULT_AUTO_START_SHARING);
export const autoStartSharing = writable(storedAutoStartSharing);

export function setAutoStartSharing(enabled: boolean): void {
	autoStartSharing.set(enabled);
	setStorageValue('autoStartSharing', enabled);
}

// System settings
const storedAutoStartOnBoot = getStorageValue<boolean>('autoStartOnBoot', true);
export const autoStartOnBoot = writable(storedAutoStartOnBoot);

export function setAutoStartOnBoot(enabled: boolean): void {
	autoStartOnBoot.set(enabled);
	setStorageValue('autoStartOnBoot', enabled);
}

const storedShowInTray = getStorageValue<boolean>('showInTray', true);
export const showInTray = writable(storedShowInTray);

export function setShowInTray(enabled: boolean): void {
	showInTray.set(enabled);
	setStorageValue('showInTray', enabled);
	// If disabling tray, also disable minimize to tray
	if (!enabled) {
		minimizeToTray.set(false);
		setStorageValue('minimizeToTray', false);
	}
}

const storedMinimizeToTray = getStorageValue<boolean>('minimizeToTray', true);
export const minimizeToTray = writable(storedMinimizeToTray);

export function setMinimizeToTray(enabled: boolean): void {
	minimizeToTray.set(enabled);
	setStorageValue('minimizeToTray', enabled);
}
