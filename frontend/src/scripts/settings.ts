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
const storedStoragePath = getStorageValue<string>('storagePath', '~/libershare/download/');
export const storagePath = writable(storedStoragePath);

export function setStoragePath(path: string): void {
	storagePath.set(path);
	setStorageValue('storagePath', path);
}

const storedStorageTempPath = getStorageValue<string>('storageTempPath', '~/libershare/temp/');
export const storageTempPath = writable(storedStorageTempPath);

export function setStorageTempPath(path: string): void {
	storageTempPath.set(path);
	setStorageValue('storageTempPath', path);
}

const storedStorageLishPath = getStorageValue<string>('storageLishPath', '~/libershare/lish/');
export const storageLishPath = writable(storedStorageLishPath);

export function setStorageLishPath(path: string): void {
	storageLishPath.set(path);
	setStorageValue('storageLishPath', path);
}

// Sharing settings
const storedIncomingPort = getStorageValue<number>('incomingPort', 9090);
export const incomingPort = writable(storedIncomingPort);

export function setIncomingPort(value: number): void {
	incomingPort.set(value);
	setStorageValue('incomingPort', value);
}

const storedMaxDownloadConnections = getStorageValue<number>('maxDownloadConnections', 200);
export const maxDownloadConnections = writable(storedMaxDownloadConnections);

export function setMaxDownloadConnections(value: number): void {
	maxDownloadConnections.set(value);
	setStorageValue('maxDownloadConnections', value);
}

const storedMaxUploadConnections = getStorageValue<number>('maxUploadConnections', 200);
export const maxUploadConnections = writable(storedMaxUploadConnections);

export function setMaxUploadConnections(value: number): void {
	maxUploadConnections.set(value);
	setStorageValue('maxUploadConnections', value);
}

const storedMaxDownloadSpeed = getStorageValue<number>('maxDownloadSpeed', 0);
export const maxDownloadSpeed = writable(storedMaxDownloadSpeed);

export function setMaxDownloadSpeed(value: number): void {
	maxDownloadSpeed.set(value);
	setStorageValue('maxDownloadSpeed', value);
}

const storedMaxUploadSpeed = getStorageValue<number>('maxUploadSpeed', 0);
export const maxUploadSpeed = writable(storedMaxUploadSpeed);

export function setMaxUploadSpeed(value: number): void {
	maxUploadSpeed.set(value);
	setStorageValue('maxUploadSpeed', value);
}

const storedAutoStartSharing = getStorageValue<boolean>('autoStartSharing', true);
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
}

const storedMinimizeToTray = getStorageValue<boolean>('minimizeToTray', true);
export const minimizeToTray = writable(storedMinimizeToTray);

export function setMinimizeToTray(enabled: boolean): void {
	minimizeToTray.set(enabled);
	setStorageValue('minimizeToTray', enabled);
}
