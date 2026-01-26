import { writable } from 'svelte/store';
const CURSOR_HIDE_DELAY = 2000;
export const cursorVisible = writable(true);

class MouseManager {
	private hideTimeout: ReturnType<typeof setTimeout> | null = null;
	private mouseMoveHandler: (() => void) | null = null;

	start(): void {
		if (this.mouseMoveHandler) return;
		this.mouseMoveHandler = () => this.handleMouseMove();
		document.addEventListener('mousemove', this.mouseMoveHandler);
		this.scheduleHide();
	}

	stop(): void {
		if (this.mouseMoveHandler) {
			document.removeEventListener('mousemove', this.mouseMoveHandler);
			this.mouseMoveHandler = null;
		}
		this.clearHideTimeout();
		cursorVisible.set(true);
	}

	private handleMouseMove(): void {
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
