import { writable } from 'svelte/store';

// Input timing settings
export const inputInitialDelay = writable(400); // ms before repeat starts
export const inputRepeatDelay = writable(150); // ms between repeats (4 items per second)

// Gamepad settings
export const gamepadDeadzone = writable(0.5);
