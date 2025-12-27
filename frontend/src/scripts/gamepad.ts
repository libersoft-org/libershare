import { writable, get, type Writable } from 'svelte/store';
import { inputInitialDelay, inputRepeatDelay, gamepadDeadzone } from './settings.ts';

export interface GamepadConfig {
	deadzone?: number;
}
export interface GamepadState {
	leftStickX: number;
	leftStickY: number;
	rightStickX: number;
	rightStickY: number;
	buttons: boolean[];
}

let globalGamepadManager: GamepadManager | null = null;

export class GamepadManager {
	private animationId: number | null = null;
	private deadzone: number;
	private lastInputTime = 0;
	private firstInputTime = 0;
	private callbacks: Map<string, (value: number) => void> = new Map();
	private previousButtons: boolean[] = [];
	public state: Writable<GamepadState> = writable({
		leftStickX: 0,
		leftStickY: 0,
		rightStickX: 0,
		rightStickY: 0,
		buttons: [],
	});

	constructor() {
		this.deadzone = get(gamepadDeadzone);
		gamepadDeadzone.subscribe(value => this.deadzone = value);
	}

	start(): void {
		if (this.animationId !== null) return;
		this.poll();
	}

	stop(): void {
		if (this.animationId !== null) {
			cancelAnimationFrame(this.animationId);
			this.animationId = null;
		}
		this.firstInputTime = 0;
		this.lastInputTime = 0;
	}

	on(key: string, callback: (value: number) => void): void {
		this.callbacks.set(key, callback);
	}

	off(key: string): void {
		this.callbacks.delete(key);
	}

	private poll = (): void => {
		const gamepads = navigator.getGamepads();
		const gamepad = gamepads[0];
		if (gamepad) {
			const leftStickX = gamepad.axes[0];
			const leftStickY = gamepad.axes[1];
			const rightStickX = gamepad.axes[2] || 0;
			const rightStickY = gamepad.axes[3] || 0;
			const buttons = gamepad.buttons.map(b => b.pressed);

			this.state.set({
				leftStickX,
				leftStickY,
				rightStickX,
				rightStickY,
				buttons,
			});
			// Check for button presses and releases
			buttons.forEach((pressed, index) => {
				const wasPressed = this.previousButtons[index];
				// Button pressed (down event)
				if (pressed && !wasPressed) {
					const callback = this.callbacks.get(`button${index}`);
					if (callback) callback(1);
					const downCallback = this.callbacks.get(`button${index}Down`);
					if (downCallback) downCallback(1);
					// Named button aliases for Xbox controller
					if (index === 0) {
						// A button
						const aCallback = this.callbacks.get('a');
						if (aCallback) aCallback(1);
						const aDownCallback = this.callbacks.get('aDown');
						if (aDownCallback) aDownCallback(1);
					}
					if (index === 1) {
						// B button
						const bCallback = this.callbacks.get('b');
						if (bCallback) bCallback(1);
						const bDownCallback = this.callbacks.get('bDown');
						if (bDownCallback) bDownCallback(1);
					}
					if (index === 2) {
						// X button
						const xCallback = this.callbacks.get('x');
						if (xCallback) xCallback(1);
						const xDownCallback = this.callbacks.get('xDown');
						if (xDownCallback) xDownCallback(1);
					}
					if (index === 3) {
						// Y button
						const yCallback = this.callbacks.get('y');
						if (yCallback) yCallback(1);
						const yDownCallback = this.callbacks.get('yDown');
						if (yDownCallback) yDownCallback(1);
					}
				}
				// Button released (up event)
				if (!pressed && wasPressed) {
					const upCallback = this.callbacks.get(`button${index}Up`);
					if (upCallback) upCallback(1);
					// Named button aliases for Xbox controller
					if (index === 0) {
						// A button
						const aUpCallback = this.callbacks.get('aUp');
						if (aUpCallback) aUpCallback(1);
					}
					if (index === 1) {
						// B button
						const bUpCallback = this.callbacks.get('bUp');
						if (bUpCallback) bUpCallback(1);
					}
					if (index === 2) {
						// X button
						const xUpCallback = this.callbacks.get('xUp');
						if (xUpCallback) xUpCallback(1);
					}
					if (index === 3) {
						// Y button
						const yUpCallback = this.callbacks.get('yUp');
						if (yUpCallback) yUpCallback(1);
					}
				}
			});
			this.previousButtons = buttons;
			const currentTime = Date.now();
			const initialDelay = get(inputInitialDelay);
			let currentDelay = initialDelay;
			if (this.firstInputTime > 0 && currentTime - this.firstInputTime > initialDelay) {
				currentDelay = get(inputRepeatDelay);
			}
			if (currentTime - this.lastInputTime > currentDelay) {
				let inputDetected = false;

				// Check D-pad buttons (buttons 12-15 on Xbox controller)
				const dpadDirections: string[] = [];
				if (buttons[12]) dpadDirections.push('up'); // D-pad up
				if (buttons[13]) dpadDirections.push('down'); // D-pad down
				if (buttons[14]) dpadDirections.push('left'); // D-pad left
				if (buttons[15]) dpadDirections.push('right'); // D-pad right

				// Check analog stick directions
				const stickDirections = this.getDirections(leftStickX, leftStickY);

				// Combine both D-pad and analog stick directions
				const allDirections = [...new Set([...dpadDirections, ...stickDirections])];

				for (const direction of allDirections) {
					const callback = this.callbacks.get(direction);
					if (callback) {
						callback(1);
						inputDetected = true;
					}
				}
				// Update timing if input was detected
				if (inputDetected) {
					this.lastInputTime = currentTime;
					if (this.firstInputTime === 0) this.firstInputTime = currentTime;
				} else this.firstInputTime = 0;
			}
			// Reset timing if stick returned to center and no D-pad pressed
			const isDpadPressed = buttons[12] || buttons[13] || buttons[14] || buttons[15];
			if (Math.abs(leftStickX) <= this.deadzone && Math.abs(leftStickY) <= this.deadzone && !isDpadPressed) {
				this.firstInputTime = 0;
			}
		}
		this.animationId = requestAnimationFrame(this.poll);
	};

	private getDirections(x: number, y: number): string[] {
		const directions: string[] = [];
		if (Math.abs(y) > this.deadzone) {
			if (y < -this.deadzone) directions.push('up');
			else if (y > this.deadzone) directions.push('down');
		}
		if (Math.abs(x) > this.deadzone) {
			if (x < -this.deadzone) directions.push('left');
			else if (x > this.deadzone) directions.push('right');
		}
		return directions;
	}
}

export function getGamepadManager(): GamepadManager {
	if (!globalGamepadManager) globalGamepadManager = new GamepadManager();
	return globalGamepadManager;
}
