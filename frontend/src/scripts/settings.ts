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
const storedStoragePath = getStorageValue<string>('storagePath', '~/lish/');
export const storagePath = writable(storedStoragePath);

export function setStoragePath(path: string): void {
	storagePath.set(path);
	setStorageValue('storagePath', path);
}

const storedStorageTempPath = getStorageValue<string>('storageTempPath', '~/lish/temp/');
export const storageTempPath = writable(storedStorageTempPath);

export function setStorageTempPath(path: string): void {
	storageTempPath.set(path);
	setStorageValue('storageTempPath', path);
}
