/** The part of a gamepad's state the navigation reads. */
interface GamepadInput {
	readonly buttons: readonly { readonly pressed: boolean }[];
	readonly axes: readonly number[];
}

/**
 * Merges the state of all connected gamepads into one, so that each of them drives the same navigation:
 * a button counts as pressed when any gamepad holds it, a stick axis takes the strongest deflection.
 */
export function mergeGamepads(gamepads: readonly GamepadInput[]): { buttons: boolean[]; stickX: number; stickY: number } {
	const buttons = Array.from({ length: Math.max(0, ...gamepads.map(gamepad => gamepad.buttons.length)) }, (_, i) => gamepads.some(gamepad => gamepad.buttons[i]?.pressed));
	const strongest = (axis: number): number => gamepads.reduce((value, gamepad) => (Math.abs(gamepad.axes[axis] ?? 0) > Math.abs(value) ? (gamepad.axes[axis] ?? 0) : value), 0);
	return { buttons, stickX: strongest(0), stickY: strongest(1) };
}
