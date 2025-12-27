import { getGamepadManager } from './gamepad.ts';
export type InputAction = 'up' | 'down' | 'left' | 'right' | 'confirmDown' | 'confirmUp' | 'back';
export type InputCallback = () => void;

class InputManager {
	private keyboardHandler: ((e: KeyboardEvent) => void) | null = null;
	private gamepadStarted = false;
	private scopeStack: string[] = [];
	private scopeCallbacks: Map<string, Map<InputAction, InputCallback>> = new Map();

	start(): void {
		this.startKeyboard();
		this.startGamepad();
	}

	stop(): void {
		this.stopKeyboard();
		this.stopGamepad();
	}

	registerScope(scopeId: string, handlers: Partial<Record<InputAction, InputCallback>>): () => void {
		// Remove existing scope if it exists
		this.unregisterScope(scopeId);

		const scopeMap = new Map<InputAction, InputCallback>();
		this.scopeCallbacks.set(scopeId, scopeMap);

		// Add to stack (most recent scope handles input)
		this.scopeStack.push(scopeId);

		// Register handlers
		for (const [action, callback] of Object.entries(handlers)) {
			if (callback) {
				const inputAction = action as InputAction;
				scopeMap.set(inputAction, callback);
			}
		}

		this.start();
		return () => this.unregisterScope(scopeId);
	}
	unregisterScope(scopeId: string): void {
		const scopeMap = this.scopeCallbacks.get(scopeId);
		if (scopeMap) {
			this.scopeCallbacks.delete(scopeId);
			// Remove from stack
			this.scopeStack = this.scopeStack.filter(id => id !== scopeId);
		}
	}

	private emit(action: InputAction): void {
		// Only call callback from the top scope (most recently registered)
		if (this.scopeStack.length === 0) return;
		const topScope = this.scopeStack[this.scopeStack.length - 1];
		const scopeMap = this.scopeCallbacks.get(topScope);
		const callback = scopeMap?.get(action);
		if (callback) callback();
	}

	private startKeyboard(): void {
		if (this.keyboardHandler) return;
		this.keyboardHandler = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
			switch (e.key) {
				case 'ArrowUp':
					e.preventDefault();
					this.emit('up');
					break;
				case 'ArrowDown':
					e.preventDefault();
					this.emit('down');
					break;
				case 'ArrowLeft':
					e.preventDefault();
					this.emit('left');
					break;
				case 'ArrowRight':
					e.preventDefault();
					this.emit('right');
					break;
				case 'Enter':
				case ' ':
					e.preventDefault();
					this.emit('confirmDown');
					setTimeout(() => this.emit('confirmUp'), 100);
					break;
				case 'Escape':
				case 'Backspace':
					e.preventDefault();
					this.emit('back');
					break;
			}
		};
		window.addEventListener('keydown', this.keyboardHandler);
	}

	private stopKeyboard(): void {
		if (this.keyboardHandler) {
			window.removeEventListener('keydown', this.keyboardHandler);
			this.keyboardHandler = null;
		}
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

export function useInput(scopeId: string, handlers: Partial<Record<InputAction, InputCallback>>): () => void {
	const manager = getInputManager();
	return manager.registerScope(scopeId, handlers);
}
