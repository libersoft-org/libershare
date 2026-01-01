import { getKeyboardManager } from './keyboard.ts';
import { getGamepadManager } from './gamepad.ts';
export type InputAction = 'up' | 'down' | 'left' | 'right' | 'confirmDown' | 'confirmUp' | 'confirmCancel' | 'back';
export type InputCallback = () => void;
export type InputHandlers = Partial<Record<InputAction, InputCallback>>;

class InputManager {
	private keyboardStarted = false;
	private gamepadStarted = false;
	// Scene management
	private scenes: Map<string, InputHandlers> = new Map();
	private activeScene: string | null = null;
	// Confirm state - tracks if confirm is "active" (not interrupted)
	private confirmActive = false;

	start(): void {
		this.startKeyboard();
		this.startGamepad();
	}

	stop(): void {
		this.stopKeyboard();
		this.stopGamepad();
	}

	registerScene(sceneId: string, handlers: InputHandlers): () => void {
		this.scenes.set(sceneId, handlers);
		this.start();
		return () => this.unregisterScene(sceneId);
	}

	unregisterScene(sceneId: string): void {
		this.scenes.delete(sceneId);
		if (this.activeScene === sceneId) {
			this.activeScene = null;
		}
	}

	activateScene(sceneId: string): void {
		if (this.scenes.has(sceneId)) {
			this.activeScene = sceneId;
		}
	}

	deactivateScene(sceneId: string): void {
		if (this.activeScene === sceneId) {
			this.activeScene = null;
		}
	}

	getActiveScene(): string | null {
		return this.activeScene;
	}

	private emit(action: InputAction): void {
		if (!this.activeScene) return;
		const handlers = this.scenes.get(this.activeScene);

		// Handle confirm state
		if (action === 'confirmDown') {
			this.confirmActive = true;
		} else if (action === 'confirmUp') {
			if (!this.confirmActive) return; // Interrupted, don't fire confirmUp
			this.confirmActive = false;
		} else if (action === 'confirmCancel') {
			this.confirmActive = false;
		} else {
			// Any other action cancels the confirm - trigger confirmCancel to reset animation
			if (this.confirmActive) {
				this.confirmActive = false;
				const cancelCallback = handlers?.['confirmCancel'];
				if (cancelCallback) cancelCallback();
			}
		}

		const callback = handlers?.[action];
		if (callback) callback();
	}

	private startKeyboard(): void {
		if (this.keyboardStarted) return;
		const keyboard = getKeyboardManager();
		keyboard.on('up', () => this.emit('up'));
		keyboard.on('down', () => this.emit('down'));
		keyboard.on('left', () => this.emit('left'));
		keyboard.on('right', () => this.emit('right'));
		keyboard.on('confirmDown', () => this.emit('confirmDown'));
		keyboard.on('confirmUp', () => this.emit('confirmUp'));
		keyboard.on('back', () => this.emit('back'));
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
		gamepad.on('up', () => this.emit('up'));
		gamepad.on('down', () => this.emit('down'));
		gamepad.on('left', () => this.emit('left'));
		gamepad.on('right', () => this.emit('right'));
		gamepad.on('aDown', () => this.emit('confirmDown'));
		gamepad.on('aUp', () => this.emit('confirmUp'));
		gamepad.on('bDown', () => this.emit('back'));
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
		gamepad.stop();
		this.gamepadStarted = false;
	}
}

let globalInputManager: InputManager | null = null;

export function getInputManager(): InputManager {
	if (!globalInputManager) globalInputManager = new InputManager();
	return globalInputManager;
}

export function registerScene(sceneId: string, handlers: InputHandlers): () => void {
	return getInputManager().registerScene(sceneId, handlers);
}

export function activateScene(sceneId: string): void {
	getInputManager().activateScene(sceneId);
}

export function deactivateScene(sceneId: string): void {
	getInputManager().deactivateScene(sceneId);
}
