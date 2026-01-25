import { getKeyboardManager } from './keyboard.ts';
import { getGamepadManager } from './gamepad.ts';
import { getMouseManager } from './mouse.ts';
import { emit } from './areas.ts';

class InputManager {
	private keyboardStarted = false;
	private gamepadStarted = false;
	private mouseStarted = false;

	start(): void {
		this.startKeyboard();
		this.startGamepad();
		this.startMouse();
	}

	stop(): void {
		this.stopKeyboard();
		this.stopGamepad();
		this.stopMouse();
	}

	private startKeyboard(): void {
		if (this.keyboardStarted) return;
		const keyboard = getKeyboardManager();
		keyboard.on('up', () => emit('up'));
		keyboard.on('down', () => emit('down'));
		keyboard.on('left', () => emit('left'));
		keyboard.on('right', () => emit('right'));
		keyboard.on('confirmDown', () => emit('confirmDown'));
		keyboard.on('confirmUp', () => emit('confirmUp'));
		keyboard.on('back', () => emit('back'));
		keyboard.start();
		this.keyboardStarted = true;
	}

	private stopKeyboard(): void {
		if (!this.keyboardStarted) return;
		const keyboard = getKeyboardManager();
		keyboard.off('up');
		keyboard.off('down');
		keyboard.off('left');
		keyboard.off('right');
		keyboard.off('confirmDown');
		keyboard.off('confirmUp');
		keyboard.off('back');
		keyboard.stop();
		this.keyboardStarted = false;
	}

	private startGamepad(): void {
		if (this.gamepadStarted) return;
		const gamepad = getGamepadManager();
		gamepad.on('up', () => emit('up'));
		gamepad.on('down', () => emit('down'));
		gamepad.on('left', () => emit('left'));
		gamepad.on('right', () => emit('right'));
		gamepad.on('aDown', () => emit('confirmDown'));
		gamepad.on('aUp', () => emit('confirmUp'));
		gamepad.on('bDown', () => emit('back'));
		gamepad.on('select', () => window.location.reload());
		gamepad.start();
		this.gamepadStarted = true;
	}

	private stopGamepad(): void {
		if (!this.gamepadStarted) return;
		const gamepad = getGamepadManager();
		gamepad.off('up');
		gamepad.off('down');
		gamepad.off('left');
		gamepad.off('right');
		gamepad.off('aDown');
		gamepad.off('aUp');
		gamepad.off('bDown');
		gamepad.off('select');
		gamepad.stop();
		this.gamepadStarted = false;
	}

	private startMouse(): void {
		if (this.mouseStarted) return;
		const mouse = getMouseManager();
		mouse.start();
		this.mouseStarted = true;
	}

	private stopMouse(): void {
		if (!this.mouseStarted) return;
		const mouse = getMouseManager();
		mouse.stop();
		this.mouseStarted = false;
	}
}

let globalInputManager: InputManager | null = null;

function getInputManager(): InputManager {
	if (!globalInputManager) globalInputManager = new InputManager();
	return globalInputManager;
}

export function startInput(): void {
	getInputManager().start();
}

export function stopInput(): void {
	getInputManager().stop();
}
