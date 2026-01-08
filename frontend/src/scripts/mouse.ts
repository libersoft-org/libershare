const CURSOR_HIDE_DELAY = 2000;

class MouseManager {
	private hideTimeout: ReturnType<typeof setTimeout> | null = null;
	private isHidden = false;
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
		this.showCursor();
	}

	private handleMouseMove(): void {
		this.showCursor();
		this.scheduleHide();
	}

	private scheduleHide(): void {
		this.clearHideTimeout();
		this.hideTimeout = setTimeout(() => this.hideCursor(), CURSOR_HIDE_DELAY);
	}

	private clearHideTimeout(): void {
		if (this.hideTimeout) {
			clearTimeout(this.hideTimeout);
			this.hideTimeout = null;
		}
	}

	private showCursor(): void {
		if (this.isHidden) {
			document.body.style.cursor = '';
			this.isHidden = false;
		}
	}

	private hideCursor(): void {
		if (!this.isHidden) {
			document.body.style.cursor = 'none';
			this.isHidden = true;
		}
	}
}

let globalMouseManager: MouseManager | null = null;

export function getMouseManager(): MouseManager {
	if (!globalMouseManager) globalMouseManager = new MouseManager();
	return globalMouseManager;
}
