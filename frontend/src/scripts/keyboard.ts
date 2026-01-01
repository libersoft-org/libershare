import { get } from 'svelte/store';
import { inputInitialDelay, inputRepeatDelay } from './settings.ts';

export type KeyboardAction = 'up' | 'down' | 'left' | 'right' | 'confirmDown' | 'confirmUp' | 'back';
export type KeyboardCallback = () => void;

class KeyboardManager {
	private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
	private keyupHandler: ((e: KeyboardEvent) => void) | null = null;
	private callbacks: Map<string, KeyboardCallback> = new Map();
	// Key repeat control
	private heldKey: string | null = null;
	private repeatTimer: ReturnType<typeof setTimeout> | null = null;
	private repeatInterval: ReturnType<typeof setInterval> | null = null;

	start(): void {
		if (this.keydownHandler) return;
		const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
		const getActionForKey = (key: string): KeyboardAction | null => {
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
						if (this.heldKey === e.key) this.emit(action);
					}, get(inputRepeatDelay));
				}, get(inputInitialDelay));
				return;
			}
			// Handle other keys normally (no repeat)
			if (e.repeat) return;
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
			if (arrowKeys.includes(e.key) && this.heldKey === e.key) clearRepeat();
		};
		window.addEventListener('keydown', this.keydownHandler);
		window.addEventListener('keyup', this.keyupHandler);
	}

	stop(): void {
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

	on(action: string, callback: KeyboardCallback): void {
		this.callbacks.set(action, callback);
	}

	off(action: string): void {
		this.callbacks.delete(action);
	}

	private emit(action: KeyboardAction): void {
		const callback = this.callbacks.get(action);
		if (callback) callback();
	}
}

let globalKeyboardManager: KeyboardManager | null = null;

export function getKeyboardManager(): KeyboardManager {
	if (!globalKeyboardManager) globalKeyboardManager = new KeyboardManager();
	return globalKeyboardManager;
}
