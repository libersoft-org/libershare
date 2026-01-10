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

export function setAudioEnabled(enabled: boolean): void {
	audioEnabled.set(enabled);
	setStorageValue('audio', enabled);
}

export function setCursorSize(size: CursorSize): void {
	cursorSize.set(size);
	setStorageValue('cursorSize', size);
}
