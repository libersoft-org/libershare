import { get, writable } from 'svelte/store';
import { inputInitialDelay, inputRepeatDelay, gamepadDeadzone, increaseVolume, decreaseVolume } from '../settings.ts';
import { addNotification } from '../notifications.ts';
import { tt } from '../language.ts';
type GamepadCallback = () => void;
let globalGamepadManager: GamepadManager | null = null;
export const gamepadConnected = writable(false);

export class GamepadManager {
	private animationID: number | null = null;
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
	// Per-button flag: was SELECT held at the moment this button went down? Used to suppress
	// normal release events (e.g. aUp) when the press was actually a SELECT+button combo.
	private pressWithSelect: boolean[] = [];
	// Connection state
	private isConnected = false;
	private started = false;
	private boundHandleConnect: (e: GamepadEvent) => void;
	private boundHandleDisconnect: (e: GamepadEvent) => void;

	constructor() {
		this.deadzone = get(gamepadDeadzone);
		gamepadDeadzone.subscribe(value => (this.deadzone = value));
		this.boundHandleConnect = this.handleConnect.bind(this);
		this.boundHandleDisconnect = this.handleDisconnect.bind(this);
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		// Listen for gamepad connection events
		window.addEventListener('gamepadconnected', this.boundHandleConnect);
		window.addEventListener('gamepaddisconnected', this.boundHandleDisconnect);
		// Check if gamepad is already connected
		const gamepads = navigator.getGamepads();
		if (gamepads[0]) {
			this.isConnected = true;
			gamepadConnected.set(true);
			this.startPolling();
		}
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		window.removeEventListener('gamepadconnected', this.boundHandleConnect);
		window.removeEventListener('gamepaddisconnected', this.boundHandleDisconnect);
		this.stopPolling();
	}

	private handleConnect(e: GamepadEvent): void {
		addNotification(tt('common.gamepadConnected', { name: e.gamepad.id }), 'success');
		this.isConnected = true;
		gamepadConnected.set(true);
		if (this.started) this.startPolling();
	}

	private handleDisconnect(e: GamepadEvent): void {
		addNotification(tt('common.gamepadDisconnected', { name: e.gamepad.id }), 'warning');
		this.isConnected = false;
		gamepadConnected.set(false);
		this.stopPolling();
	}

	private startPolling(): void {
		if (this.animationID !== null) return;
		this.poll();
	}

	private stopPolling(): void {
		if (this.animationID !== null) {
			cancelAnimationFrame(this.animationID);
			this.animationID = null;
		}
		this.firstInputTime = 0;
		this.lastInputTime = 0;
		this.previousButtons = [];
		this.pressWithSelect = [];
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
		if (!this.isConnected) return;
		const gamepad = navigator.getGamepads()[0];
		if (!gamepad) {
			// Gamepad disappeared unexpectedly
			this.isConnected = false;
			gamepadConnected.set(false);
			this.animationID = null;
			return;
		}
		const buttons = gamepad.buttons.map(b => b.pressed);
		const leftStickX = gamepad.axes[0] ?? 0;
		const leftStickY = gamepad.axes[1] ?? 0;
		const now = Date.now();
		// A/B button press/release events
		this.handleButtons(buttons);
		// Direction handling (D-pad + analog stick) with repeat
		this.handleDirections(buttons, leftStickX, leftStickY, now);
		// Volume handling (Y = decrease, X = increase) with repeat
		this.handleVolume(buttons, now);
		this.animationID = requestAnimationFrame(this.poll);
	};

	private handleButtons(buttons: boolean[]): void {
		const selectHeld = !!buttons[8];
		const startHeld = !!buttons[9];
		// A (0) - confirm, or pageDown when SELECT is held
		if (buttons[0] && !this.previousButtons[0]) {
			if (selectHeld) this.emit('pageDown');
			else if (!startHeld) this.emit('aDown');
		}
		// Emit aUp on release only if aDown was emitted on press (i.e. not a combo press).
		// previousSelectOnPress[n] tracks whether SELECT was held at the moment the button went down.
		if (!buttons[0] && this.previousButtons[0] && !this.pressWithSelect[0]) this.emit('aUp');
		// B (1) - back, or pageUp when SELECT is held
		if (buttons[1] && !this.previousButtons[1]) {
			if (selectHeld) this.emit('pageUp');
			else if (!startHeld) this.emit('bDown');
		}
		// X (3) - SELECT+X = end (X alone is handled in handleVolume as decrease volume)
		if (buttons[3] && !this.previousButtons[3] && selectHeld) this.emit('end');
		// Y (4) - SELECT+Y = home, START+Y = reload (Y alone is handled in handleVolume as increase volume)
		if (buttons[4] && !this.previousButtons[4]) {
			if (selectHeld) this.emit('home');
			else if (startHeld) this.emit('reload');
		}
		// Remember which buttons were pressed WITH select/start held (so release suppresses normal release events)
		for (let i = 0; i < buttons.length; i++) {
			if (buttons[i] && !this.previousButtons[i]) this.pressWithSelect[i] = selectHeld || startHeld;
			else if (!buttons[i]) this.pressWithSelect[i] = false;
		}
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
			for (const dir of uniqueDirections) this.emit(dir);
			this.lastInputTime = now;
			if (this.firstInputTime === 0) this.firstInputTime = now;
		}
	}

	private handleVolume(buttons: boolean[], now: number): void {
		// While SELECT or START is held, X/Y act as combo modifiers — suppress volume.
		if (buttons[8] || buttons[9]) {
			this.volumeButtonHeld = null;
			this.volumeFirstTime = 0;
			return;
		}
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
