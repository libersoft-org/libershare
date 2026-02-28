import { writable } from 'svelte/store';
type MouseAction = 'back';
type MouseCallback = () => void;
const CURSOR_HIDE_DELAY = 2000;
export const cursorVisible = writable(true);

class MouseManager {
	private hideTimeout: ReturnType<typeof setTimeout> | null = null;
	private mouseMoveHandler: (() => void) | null = null;
	private clickHandler: (() => void) | null = null;
	private contextmenuHandler: ((e: MouseEvent) => void) | null = null;
	private callbacks: Map<string, MouseCallback> = new Map();

	start(): void {
		if (this.mouseMoveHandler) return;
		this.mouseMoveHandler = () => this.handleMouseMove();
		this.clickHandler = () => this.handleClick();
		this.contextmenuHandler = (e: MouseEvent) => {
			e.preventDefault();
			this.emit('back');
		};
		document.addEventListener('mousemove', this.mouseMoveHandler);
		document.addEventListener('mousedown', this.clickHandler);
		window.addEventListener('contextmenu', this.contextmenuHandler);
		this.scheduleHide();
	}

	stop(): void {
		if (this.mouseMoveHandler) {
			document.removeEventListener('mousemove', this.mouseMoveHandler);
			this.mouseMoveHandler = null;
		}
		if (this.clickHandler) {
			document.removeEventListener('mousedown', this.clickHandler);
			this.clickHandler = null;
		}
		if (this.contextmenuHandler) {
			window.removeEventListener('contextmenu', this.contextmenuHandler);
			this.contextmenuHandler = null;
		}
		this.clearHideTimeout();
		cursorVisible.set(true);
	}

	on(action: string, callback: MouseCallback): void {
		this.callbacks.set(action, callback);
	}

	off(action: string): void {
		this.callbacks.delete(action);
	}

	private emit(action: MouseAction): void {
		const callback = this.callbacks.get(action);
		if (callback) callback();
	}

	private handleMouseMove(): void {
		cursorVisible.set(true);
		this.scheduleHide();
	}

	private handleClick(): void {
		cursorVisible.set(true);
		this.scheduleHide();
	}

	private scheduleHide(): void {
		this.clearHideTimeout();
		this.hideTimeout = setTimeout(() => cursorVisible.set(false), CURSOR_HIDE_DELAY);
	}

	private clearHideTimeout(): void {
		if (this.hideTimeout) {
			clearTimeout(this.hideTimeout);
			this.hideTimeout = null;
		}
	}
}

let globalMouseManager: MouseManager | null = null;

export function getMouseManager(): MouseManager {
	if (!globalMouseManager) globalMouseManager = new MouseManager();
	return globalMouseManager;
}
