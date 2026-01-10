import { get } from 'svelte/store';
import { inputInitialDelay, inputRepeatDelay, increaseVolume, decreaseVolume } from './settings.ts';
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
	// Confirm key state
	private confirmKeyHeld = false;

	start(): void {
		if (this.keydownHandler) return;
		const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
		const volumeKeys = ['+', '-'];
		const confirmKeys = ['Enter', ' '];
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
		const getVolumeAction = (key: string): (() => void) | null => {
			switch (key) {
				case '+':
					return increaseVolume;
				case '-':
					return decreaseVolume;
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
			// Handle volume keys with custom repeat
			if (volumeKeys.includes(e.key)) {
				e.preventDefault();
				if (e.repeat) return;
				if (this.heldKey === e.key) return;
				clearRepeat();
				const volumeAction = getVolumeAction(e.key);
				if (!volumeAction) return;
				volumeAction();
				this.heldKey = e.key;
				this.repeatTimer = setTimeout(() => {
					this.repeatInterval = setInterval(() => {
						if (this.heldKey === e.key) volumeAction();
					}, get(inputRepeatDelay));
				}, get(inputInitialDelay));
				return;
			}
			// Handle confirm keys (Enter/Space) with real keyup
			if (confirmKeys.includes(e.key)) {
				e.preventDefault();
				if (e.repeat) return;
				if (this.confirmKeyHeld) return;
				this.confirmKeyHeld = true;
				this.emit('confirmDown');
				return;
			}
			// Handle other keys normally (no repeat)
			if (e.repeat) return;
			switch (e.key) {
				case 'Escape':
				case 'Backspace':
					e.preventDefault();
					this.emit('back');
					break;
			}
		};
		this.keyupHandler = (e: KeyboardEvent) => {
			if ((arrowKeys.includes(e.key) || volumeKeys.includes(e.key)) && this.heldKey === e.key) clearRepeat();
			// Handle confirm key release
			if (confirmKeys.includes(e.key) && this.confirmKeyHeld) {
				this.confirmKeyHeld = false;
				this.emit('confirmUp');
			}
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
		this.confirmKeyHeld = false;
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
