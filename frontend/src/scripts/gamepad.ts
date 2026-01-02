import { get } from 'svelte/store';
import { inputInitialDelay, inputRepeatDelay, gamepadDeadzone } from './settings.ts';

type GamepadCallback = () => void;

const BUTTON_NAMES: Record<number, string> = {
	0: 'a',
	1: 'b',
	2: 'x',
	3: 'y',
};

let globalGamepadManager: GamepadManager | null = null;

export class GamepadManager {
	private animationId: number | null = null;
	private deadzone: number;
	private lastInputTime = 0;
	private firstInputTime = 0;
	private callbacks: Map<string, GamepadCallback> = new Map();
	private previousButtons: boolean[] = [];

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

	on(key: string, callback: GamepadCallback): void {
		this.callbacks.set(key, callback);
	}

	off(key: string): void {
		this.callbacks.delete(key);
	}

	private emit(key: string): void {
		const callback = this.callbacks.get(key);
		if (callback) callback();
	}

	private poll = (): void => {
		const gamepads = navigator.getGamepads();
		const gamepad = gamepads[0];
		if (gamepad) {
			const leftStickX = gamepad.axes[0];
			const leftStickY = gamepad.axes[1];
			const buttons = gamepad.buttons.map(b => b.pressed);

			// Check for button presses and releases
			buttons.forEach((pressed, index) => {
				const wasPressed = this.previousButtons[index];
				const buttonName = BUTTON_NAMES[index];
				// Button pressed (down event)
				if (pressed && !wasPressed) {
					this.emit(`button${index}`);
					this.emit(`button${index}Down`);
					if (buttonName) {
						this.emit(buttonName);
						this.emit(`${buttonName}Down`);
					}
				}
				// Button released (up event)
				if (!pressed && wasPressed) {
					this.emit(`button${index}Up`);
					if (buttonName) {
						this.emit(`${buttonName}Up`);
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
					this.emit(direction);
					inputDetected = true;
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
