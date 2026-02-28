import { get } from 'svelte/store';
import { inputInitialDelay, inputRepeatDelay, increaseVolume, decreaseVolume } from '../settings.ts';
type KeyboardAction = 'up' | 'down' | 'left' | 'right' | 'confirmDown' | 'confirmUp' | 'back' | 'debug' | 'reload';
type KeyboardCallback = () => void;
const ARROW_KEYS: Record<string, KeyboardAction> = {
	ArrowUp: 'up',
	ArrowDown: 'down',
	ArrowLeft: 'left',
	ArrowRight: 'right',
};
const VOLUME_KEYS: Record<string, () => void> = {
	'+': increaseVolume,
	'-': decreaseVolume,
};
const CONFIRM_KEYS = ['Enter', ' '];

class KeyboardManager {
	private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
	private keyupHandler: ((e: KeyboardEvent) => void) | null = null;

	private callbacks: Map<string, KeyboardCallback> = new Map();
	private heldKey: string | null = null;
	private repeatTimer: ReturnType<typeof setTimeout> | null = null;
	private repeatInterval: ReturnType<typeof setInterval> | null = null;
	private confirmKeyHeld = false;

	start(): void {
		if (this.keydownHandler) return;

		const clearRepeat = () => {
			if (this.repeatTimer) clearTimeout(this.repeatTimer);
			if (this.repeatInterval) clearInterval(this.repeatInterval);
			this.repeatTimer = null;
			this.repeatInterval = null;
			this.heldKey = null;
		};

		const setupRepeat = (key: string, action: () => void) => {
			if (this.heldKey === key) return;
			clearRepeat();
			action();
			this.heldKey = key;
			this.repeatTimer = setTimeout(() => {
				this.repeatInterval = setInterval(() => {
					if (this.heldKey === key) action();
				}, get(inputRepeatDelay));
			}, get(inputInitialDelay));
		};

		this.keydownHandler = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
			if (e.repeat) return;
			// Arrow keys (with repeat)
			const arrowAction = ARROW_KEYS[e.key];
			if (arrowAction) {
				e.preventDefault();
				setupRepeat(e.key, () => this.emit(arrowAction));
				return;
			}
			// Volume keys (with repeat)
			const volumeAction = VOLUME_KEYS[e.key];
			if (volumeAction) {
				e.preventDefault();
				setupRepeat(e.key, volumeAction);
				return;
			}
			// Confirm keys (with keyup)
			if (CONFIRM_KEYS.includes(e.key)) {
				e.preventDefault();
				if (this.confirmKeyHeld) return;
				this.confirmKeyHeld = true;
				this.emit('confirmDown');
				return;
			}
			// Back keys (single press)
			if (e.key === 'Escape' || e.key === 'Backspace') {
				e.preventDefault();
				this.emit('back');
				return;
			}
			// F2 - debug toggle
			if (e.key === 'F2') {
				e.preventDefault();
				this.emit('debug');
				return;
			}
			// F3 - reload
			if (e.key === 'F3') {
				e.preventDefault();
				this.emit('reload');
				return;
			}
		};

		this.keyupHandler = (e: KeyboardEvent) => {
			if (this.heldKey === e.key) clearRepeat();
			if (CONFIRM_KEYS.includes(e.key) && this.confirmKeyHeld) {
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

		if (this.repeatTimer) clearTimeout(this.repeatTimer);
		if (this.repeatInterval) clearInterval(this.repeatInterval);
		this.repeatTimer = null;
		this.repeatInterval = null;
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
