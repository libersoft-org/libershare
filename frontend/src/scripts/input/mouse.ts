import { writable } from 'svelte/store';
import { findBindingForElement, type NavItem } from '../navArea.svelte.ts';
import { activateArea } from '../areas.ts';
type MouseAction = 'back';
type MouseCallback = () => void;
const CURSOR_HIDE_DELAY = 2000;
export const cursorVisible = writable(true);

/**
 * Single global mouse-event delegator. Components register navigation items
 * via NavArea (and a global binding registry); this manager listens once on
 * `document` and dispatches click / hover into the matching NavItem.
 *
 * Cursor visibility, contextmenu→back, and per-event delegation are all owned
 * by this class so the rest of the codebase can stay free of per-element
 * onclick/onmouseenter handlers (except components with custom click logic
 * that opt out via NavItem.delegateMouse=false).
 */
class MouseManager {
	private hideTimeout: ReturnType<typeof setTimeout> | null = null;
	private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;
	private mouseDownHandler: (() => void) | null = null;
	private clickHandler: ((e: MouseEvent) => void) | null = null;
	private mouseOverHandler: ((e: MouseEvent) => void) | null = null;
	private contextmenuHandler: ((e: MouseEvent) => void) | null = null;
	private callbacks: Map<string, MouseCallback> = new Map();
	private hoverRafId: number | null = null;
	private pendingHoverTarget: EventTarget | null = null;
	private lastHoveredItem: NavItem | null = null;
	private lastActivatedAreaID: string | null = null;

	start(): void {
		if (this.mouseMoveHandler) return;
		this.mouseMoveHandler = () => this.handleMouseMove();
		this.mouseDownHandler = () => this.handleMouseDown();
		this.clickHandler = (e: MouseEvent) => this.handleDelegatedClick(e);
		this.mouseOverHandler = (e: MouseEvent) => this.handleDelegatedMouseOver(e);
		this.contextmenuHandler = (e: MouseEvent) => {
			e.preventDefault();
			this.emit('back');
		};
		document.addEventListener('mousemove', this.mouseMoveHandler);
		document.addEventListener('mousedown', this.mouseDownHandler);
		document.addEventListener('click', this.clickHandler);
		document.addEventListener('mouseover', this.mouseOverHandler);
		window.addEventListener('contextmenu', this.contextmenuHandler);
		this.scheduleHide();
	}

	stop(): void {
		if (this.mouseMoveHandler) {
			document.removeEventListener('mousemove', this.mouseMoveHandler);
			this.mouseMoveHandler = null;
		}
		if (this.mouseDownHandler) {
			document.removeEventListener('mousedown', this.mouseDownHandler);
			this.mouseDownHandler = null;
		}
		if (this.clickHandler) {
			document.removeEventListener('click', this.clickHandler);
			this.clickHandler = null;
		}
		if (this.mouseOverHandler) {
			document.removeEventListener('mouseover', this.mouseOverHandler);
			this.mouseOverHandler = null;
		}
		if (this.contextmenuHandler) {
			window.removeEventListener('contextmenu', this.contextmenuHandler);
			this.contextmenuHandler = null;
		}
		if (this.hoverRafId !== null) {
			cancelAnimationFrame(this.hoverRafId);
			this.hoverRafId = null;
		}
		this.pendingHoverTarget = null;
		this.lastHoveredItem = null;
		this.lastActivatedAreaID = null;
		this.clearHideTimeout();
		cursorVisible.set(true);
	}

	/** Register a callback for a mouse action. */
	on(action: MouseAction, callback: MouseCallback): void {
		this.callbacks.set(action, callback);
	}

	/** Unregister a callback for a mouse action. */
	off(action: MouseAction): void {
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

	private handleMouseDown(): void {
		cursorVisible.set(true);
		this.scheduleHide();
	}

	/**
	 * Click delegation: find the deepest registered NavItem on the event path
	 * and trigger its select/activate/onConfirm. Falls back to the
	 * `[data-mouse-activate-area]` attribute for wrappers that only want to
	 * activate an area (e.g. form rows whose actual NavItem is the inner
	 * Input/Select).
	 */
	private handleDelegatedClick(e: MouseEvent): void {
		const binding = findBindingForElement(e.target);
		if (binding) {
			activateArea(binding.controller.areaID);
			binding.controller.select(binding.item.pos);
			binding.item.onConfirm?.();
			return;
		}
		const target = e.target;
		if (target instanceof HTMLElement) {
			const areaEl = target.closest('[data-mouse-activate-area]') as HTMLElement | null;
			const areaID = areaEl?.getAttribute('data-mouse-activate-area');
			if (areaID) activateArea(areaID);
		}
	}

	/**
	 * Hover delegation: throttled via rAF. Only fires select/activate when the
	 * hovered item actually changes — avoids spamming select() on every pixel
	 * move within the same row.
	 */
	private handleDelegatedMouseOver(e: MouseEvent): void {
		this.pendingHoverTarget = e.target;
		if (this.hoverRafId !== null) return;
		this.hoverRafId = requestAnimationFrame(() => {
			this.hoverRafId = null;
			const target = this.pendingHoverTarget;
			this.pendingHoverTarget = null;
			this.processHover(target);
		});
	}

	private processHover(target: EventTarget | null): void {
		const binding = findBindingForElement(target);
		if (binding) {
			if (this.lastHoveredItem === binding.item) return;
			this.lastHoveredItem = binding.item;
			// Select first so the subsequent activateArea -> onActivate scrolls
			// to the row under the cursor (already in view) rather than the
			// previously selected row in that area.
			binding.controller.select(binding.item.pos);
			activateArea(binding.controller.areaID);
			this.lastActivatedAreaID = binding.controller.areaID;
			return;
		}
		this.lastHoveredItem = null;
		if (target instanceof HTMLElement) {
			const areaEl = target.closest('[data-mouse-activate-area]') as HTMLElement | null;
			const areaID = areaEl?.getAttribute('data-mouse-activate-area');
			if (areaID && areaID !== this.lastActivatedAreaID) {
				activateArea(areaID);
				this.lastActivatedAreaID = areaID;
			}
		}
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
