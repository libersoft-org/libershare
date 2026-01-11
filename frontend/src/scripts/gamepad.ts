import { get } from 'svelte/store';
import { inputInitialDelay, inputRepeatDelay, gamepadDeadzone, increaseVolume, decreaseVolume } from './settings.ts';
type GamepadCallback = () => void;
let globalGamepadManager: GamepadManager | null = null;

export class GamepadManager {
	private animationId: number | null = null;
	private deadzone: number;
	private callbacks: Map<string, GamepadCallback> = new Map();
	// Repeat tracking
	private firstInputTime = 0;
	private lastInputTime = 0;
	private volumeFirstTime = 0;
	private volumeLastTime = 0;
	private volumeButtonHeld: number | null = null;
	// Button state tracking (for A/B press/release)
	private previousButtons: boolean[] = [];

	constructor() {
		this.deadzone = get(gamepadDeadzone);
		gamepadDeadzone.subscribe(value => (this.deadzone = value));
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
		const gamepad = navigator.getGamepads()[0];
		if (!gamepad) {
			this.animationId = requestAnimationFrame(this.poll);
			return;
		}
		const buttons = gamepad.buttons.map(b => b.pressed);
		const leftStickX = gamepad.axes[0];
		const leftStickY = gamepad.axes[1];
		const now = Date.now();
		// A/B button press/release events
		this.handleButtons(buttons);
		// Direction handling (D-pad + analog stick) with repeat
		this.handleDirections(buttons, leftStickX, leftStickY, now);
		// Volume handling (Y = decrease, X = increase) with repeat
		this.handleVolume(buttons, now);
		this.animationId = requestAnimationFrame(this.poll);
	};

	private handleButtons(buttons: boolean[]): void {
		// A button (0) - confirm
		if (buttons[0] && !this.previousButtons[0]) this.emit('aDown');
		if (!buttons[0] && this.previousButtons[0]) this.emit('aUp');
		// B button (1) - back
		if (buttons[1] && !this.previousButtons[1]) this.emit('bDown');
		if (!buttons[1] && this.previousButtons[1]) this.emit('bUp');
		this.previousButtons = [...buttons];
	}

	private handleDirections(buttons: boolean[], stickX: number, stickY: number, now: number): void {
		const directions: string[] = [];
		// D-pad (buttons 12-15)
		if (buttons[12]) directions.push('up');
		if (buttons[13]) directions.push('down');
		if (buttons[14]) directions.push('left');
		if (buttons[15]) directions.push('right');
		// Analog stick
		if (stickY < -this.deadzone) directions.push('up');
		else if (stickY > this.deadzone) directions.push('down');
		if (stickX < -this.deadzone) directions.push('left');
		else if (stickX > this.deadzone) directions.push('right');
		// Deduplicate
		const uniqueDirections = [...new Set(directions)];
		if (uniqueDirections.length === 0) {
			this.firstInputTime = 0;
			return;
		}
		// Check repeat timing
		const delay = this.firstInputTime > 0 && now - this.firstInputTime > get(inputInitialDelay) ? get(inputRepeatDelay) : get(inputInitialDelay);
		if (now - this.lastInputTime >= delay) {
			for (const dir of uniqueDirections) {
				this.emit(dir);
			}
			this.lastInputTime = now;
			if (this.firstInputTime === 0) this.firstInputTime = now;
		}
	}

	private handleVolume(buttons: boolean[], now: number): void {
		const currentButton = buttons[4] ? 4 : buttons[3] ? 3 : null;
		if (currentButton === null) {
			this.volumeButtonHeld = null;
			this.volumeFirstTime = 0;
			return;
		}

		// New button or same held?
		if (this.volumeButtonHeld !== currentButton) {
			this.volumeButtonHeld = currentButton;
			this.volumeFirstTime = now;
			this.volumeLastTime = now;
			this.triggerVolume(currentButton);
			return;
		}

		// Check repeat timing
		const delay = now - this.volumeFirstTime > get(inputInitialDelay) ? get(inputRepeatDelay) : get(inputInitialDelay);
		if (now - this.volumeLastTime >= delay) {
			this.triggerVolume(currentButton);
			this.volumeLastTime = now;
		}
	}

	private triggerVolume(button: number): void {
		if (button === 4) increaseVolume();
		else if (button === 3) decreaseVolume();
	}
}

export function getGamepadManager(): GamepadManager {
	if (!globalGamepadManager) globalGamepadManager = new GamepadManager();
	return globalGamepadManager;
}
