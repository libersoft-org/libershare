import { get } from 'svelte/store';
import { getGamepadManager } from './gamepad.ts';
import { inputInitialDelay, inputRepeatDelay } from './settings.ts';
export type InputAction = 'up' | 'down' | 'left' | 'right' | 'confirmDown' | 'confirmUp' | 'back';
export type InputCallback = () => void;

class InputManager {
	private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
	private keyupHandler: ((e: KeyboardEvent) => void) | null = null;
	private gamepadStarted = false;
	private scopeStack: string[] = [];
	private scopeCallbacks: Map<string, Map<InputAction, InputCallback>> = new Map();

	// Key repeat control
	private heldKey: string | null = null;
	private repeatTimer: ReturnType<typeof setTimeout> | null = null;
	private repeatInterval: ReturnType<typeof setInterval> | null = null;

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
		console.log('[input] emit', action, 'scope:', topScope, 'stack:', [...this.scopeStack]);
		if (callback) callback();
	}

	private startKeyboard(): void {
		if (this.keydownHandler) return;
		const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
		const getActionForKey = (key: string): InputAction | null => {
			switch (key) {
				case 'ArrowUp':
					return 'up';
				case 'ArrowDown':
					return 'down';
				case 'ArrowLeft':
					return 'left';
				case 'ArrowRight':
					return 'right';
				default:
					return null;
			}
		};

		const clearRepeat = () => {
			if (this.repeatTimer) {
				clearTimeout(this.repeatTimer);
				this.repeatTimer = null;
			}
			if (this.repeatInterval) {
				clearInterval(this.repeatInterval);
				this.repeatInterval = null;
			}
			this.heldKey = null;
		};

		this.keydownHandler = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

			// Handle arrow keys with custom repeat
			if (arrowKeys.includes(e.key)) {
				e.preventDefault();

				// If it's a repeat event from the system, ignore it (we handle repeat ourselves)
				if (e.repeat) return;

				// If same key is already held, ignore
				if (this.heldKey === e.key) return;

				// Clear any existing repeat for different key
				clearRepeat();

				const action = getActionForKey(e.key);
				if (!action) return;

				// Emit immediately on first press
				this.emit(action);

				// Set up custom repeat
				this.heldKey = e.key;
				this.repeatTimer = setTimeout(() => {
					this.repeatInterval = setInterval(() => {
						if (this.heldKey === e.key) {
							this.emit(action);
						}
					}, get(inputRepeatDelay));
				}, get(inputInitialDelay));

				return;
			}

			// Handle other keys normally
			switch (e.key) {
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

		this.keyupHandler = (e: KeyboardEvent) => {
			if (arrowKeys.includes(e.key) && this.heldKey === e.key) {
				clearRepeat();
			}
		};

		window.addEventListener('keydown', this.keydownHandler);
		window.addEventListener('keyup', this.keyupHandler);
	}

	private stopKeyboard(): void {
		if (this.keydownHandler) {
			window.removeEventListener('keydown', this.keydownHandler);
			this.keydownHandler = null;
		}
		if (this.keyupHandler) {
			window.removeEventListener('keyup', this.keyupHandler);
			this.keyupHandler = null;
		}
		// Clear any active repeats
		if (this.repeatTimer) {
			clearTimeout(this.repeatTimer);
			this.repeatTimer = null;
		}
		if (this.repeatInterval) {
			clearInterval(this.repeatInterval);
			this.repeatInterval = null;
		}
		this.heldKey = null;
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
