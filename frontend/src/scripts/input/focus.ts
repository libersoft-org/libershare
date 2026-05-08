import { readable } from 'svelte/store';

// Shared "is the app window currently active?" store. Polling-based input devices
// (gamepad, TV remote, custom HID, ...) should subscribe
// to this and pause themselves when the window is not focused / not visible, so
// they don't fire input while the user is in another app.
//
// DOM-event-based devices (keyboard, mouse) don't need this — the browser
// already only delivers their events to the focused window.
export const windowActive = readable(computeActive(), set => {
	const update = (): void => set(computeActive());
	window.addEventListener('focus', update);
	window.addEventListener('blur', update);
	document.addEventListener('visibilitychange', update);
	return (): void => {
		window.removeEventListener('focus', update);
		window.removeEventListener('blur', update);
		document.removeEventListener('visibilitychange', update);
	};
});

function computeActive(): boolean {
	return document.hasFocus() && document.visibilityState === 'visible';
}
