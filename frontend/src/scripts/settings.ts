import { writable } from 'svelte/store';
import { getStorageValue, setStorageValue } from './localStorage.ts';
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
