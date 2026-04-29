import { type Direction, useArea, activateArea, activeArea } from './areas.ts';
import { type Position } from './navigationLayout.ts';
import { setContext, onMount } from 'svelte';
import { get } from 'svelte/store';

// Types for declarative navigation items
export type NavPos = [x: number, y: number];

export interface NavItem {
	pos: NavPos;
	el?: HTMLElement | undefined;
	onConfirm?: (() => void) | undefined;
	onPress?: (() => void) | undefined;
	onRelease?: (() => void) | undefined;
	onActivate?: (() => void) | undefined;
	/**
	 * When false, MouseManager delegation skips this item. The component then
	 * owns its own onclick/onmouseenter logic (e.g. ButtonsGroup index pick,
	 * Switch toggle). Default true.
	 */
	delegateMouse?: boolean;
}

/** Options for navItem() factory. */
export interface NavItemOptions {
	/** Disable mouse-event delegation for this item. Default: false (delegation enabled). */
	noDelegateMouse?: boolean;
}

/** Create a NavItem with reactive pos and el getters */
export function navItem(getPos: () => NavPos, getEl: () => HTMLElement | undefined, onConfirm?: () => void, opts?: NavItemOptions): NavItem {
	return {
		get pos() {
			return getPos();
		},
		get el() {
			return getEl();
		},
		onConfirm,
		delegateMouse: !opts?.noDelegateMouse,
	};
}

/** Binding stored in the global registry — links a NavItem back to its NavAreaController. */
export interface NavItemBinding {
	controller: NavAreaController;
	item: NavItem;
}

/**
 * Module-level registry of every registered NavItem across all NavAreas.
 * MouseManager queries this via findBindingForElement() to delegate click/hover
 * events without needing per-component handlers.
 */
const allBindings = new Set<NavItemBinding>();

/**
 * Walk the parentElement chain from `target` and return the first NavItem whose
 * `el` is on the chain. Items with `delegateMouse: false` are ignored. Returns
 * null when no match is found.
 */
export function findBindingForElement(target: EventTarget | null): NavItemBinding | null {
	if (!(target instanceof HTMLElement)) return null;
	let node: HTMLElement | null = target;
	while (node) {
		for (const binding of allBindings) {
			if (binding.item.delegateMouse !== false && binding.item.el === node) return binding;
		}
		node = node.parentElement;
	}
	return null;
}

export interface NavAreaController {
	/** Register a navigable item. Returns cleanup function. */
	register(item: NavItem): () => void;
	/** Check if item at given position is the currently selected one */
	isSelected(pos: NavPos): boolean;
	/** Check if any item at the given Y coordinate is selected */
	isYSelected(y: number): boolean;
	/** Check if item at given position is currently pressed (confirmDown active) */
	isPressed(pos: NavPos): boolean;
	/** Programmatically set the selected position */
	select(pos: NavPos): void;
	/** Get the active area ID for this controller */
	readonly areaID: string;
}

/** Find closest item in a direction from current position */
export function findItemInDirection(items: NavItem[], currentPos: NavPos, direction: Direction): NavItem | null {
	const [cx, cy] = currentPos;

	if (direction === 'left' || direction === 'right') {
		// Horizontal: same Y, closest X in direction
		let closest: NavItem | null = null;
		let closestX = direction === 'left' ? -Infinity : Infinity;
		for (const item of items) {
			if (item.pos[1] !== cy) continue;
			if (direction === 'left') {
				if (item.pos[0] < cx && item.pos[0] > closestX) {
					closestX = item.pos[0];
					closest = item;
				}
			} else {
				if (item.pos[0] > cx && item.pos[0] < closestX) {
					closestX = item.pos[0];
					closest = item;
				}
			}
		}
		return closest;
	} else {
		// Vertical: closest Y in direction, then closest X
		let closest: NavItem | null = null;
		let closestY = direction === 'up' ? -Infinity : Infinity;
		let closestDistance = Infinity;
		for (const item of items) {
			const validDirection = direction === 'up' ? item.pos[1] < cy : item.pos[1] > cy;
			if (!validDirection) continue;
			const betterY = direction === 'up' ? item.pos[1] > closestY : item.pos[1] < closestY;
			const sameY = item.pos[1] === closestY;
			const distance = Math.abs(item.pos[0] - cx);
			if (betterY || (sameY && distance < closestDistance)) {
				closestY = item.pos[1];
				closestDistance = distance;
				closest = item;
			}
		}
		return closest;
	}
}

/** Scroll to the element of a nav item if it has one */
export function scrollToNavItem(item: NavItem): void {
	if (!item.el) return;
	// Use scrollIntoView with smooth behavior
	item.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Options for createNavArea
export interface NavAreaOptions {
	/** Unique identifier for the area */
	areaID: string;
	/** Position in the spatial area layout */
	position: Position;
	/** Activate this area on mount */
	activate?: boolean;
	/** Trap navigation — prevent leaving the area (for modal dialogs) */
	trap?: boolean;
	/** Initial selected position (defaults to top-left item) */
	initialPosition?: NavPos | undefined;
	onBack?: (() => void) | undefined;
	/** Called when pressing down and no item below. Return area ID to navigate to, or false */
	onDown?: (() => string | false) | undefined;
	/** Called when the area is activated */
	onActivate?: (() => void) | undefined;
	/** Called when selected item changes */
	onSelect?: ((pos: NavPos) => void) | undefined;
	/**
	 * Y-range of the list/table inside this area, as `[minY, maxY]` (inclusive).
	 * Only when the currently selected item's Y is within this range will pageUp/pageDown/home/end act,
	 * and they stay strictly inside the range. Without this option, those actions are no-ops.
	 */
	listRange?: (() => [number, number]) | undefined;
}

/** Handle returned by createNavArea for dynamic area management */
export interface NavAreaHandle {
	/** Temporarily unregister the area (e.g. when opening a sub-page) */
	pause(): void;
	/** Re-register the area after pausing */
	resume(): void;
	/** Direct access to the controller for manual item registration */
	readonly controller: NavAreaController;
}

/**
 * Create a declarative navigation area. Call this in a component's top-level script.
 * Sets up context for child components (Button, NavItem, etc.) to register into.
 *
 * @param getConfig - Getter function returning area config (wraps props in closure to avoid state_referenced_locally warnings)
 * @returns Handle with pause/resume for dynamic area management
 */
export function createNavArea(getConfig: () => NavAreaOptions): NavAreaHandle {
	const { areaID, position, activate = false, trap = false, initialPosition, onBack, onDown, onActivate: onAreaActivate, onSelect } = getConfig();

	// Reactive state (runes work in .svelte.ts)
	let items: NavItem[] = [];
	let selectedPos = $state<NavPos | null>(initialPosition ?? null);
	let pressed = $state(false);
	let isAreaActive = $state(get(activeArea) === areaID);

	function currentItem(): NavItem | undefined {
		if (!selectedPos) return undefined;
		return items.find(i => i.pos[0] === selectedPos![0] && i.pos[1] === selectedPos![1]);
	}

	function selectItem(item: NavItem): void {
		selectedPos = item.pos;
		scrollToNavItem(item);
		item.onActivate?.();
		onSelect?.(item.pos);
	}

	function selectFirst(): void {
		if (items.length === 0) return;
		let best = items[0]!;
		for (const item of items) if (item.pos[1] < best.pos[1] || (item.pos[1] === best.pos[1] && item.pos[0] < best.pos[0])) best = item;
		selectItem(best);
	}

	const PAGE_SIZE = 10;

	/** Get the list's [minY, maxY] range if defined. Items outside this range are not navigated to by page/home/end. */
	function getListRange(): [number, number] | null {
		const range = getConfig().listRange?.();
		return range ?? null;
	}

	/** Items within the configured listRange, in the currently selected column, sorted by y. */
	function listColumnItems(): NavItem[] {
		if (!selectedPos) return [];
		const range = getListRange();
		if (!range) return [];
		const [minY, maxY] = range;
		// Only act if current selection is inside the list range
		if (selectedPos[1] < minY || selectedPos[1] > maxY) return [];
		return items.filter(i => i.pos[0] === selectedPos![0] && i.pos[1] >= minY && i.pos[1] <= maxY).sort((a, b) => a.pos[1] - b.pos[1]);
	}

	function jumpBy(delta: number): void {
		const col = listColumnItems();
		if (col.length === 0) return;
		const idx = col.findIndex(i => i.pos[1] === selectedPos![1]);
		if (idx < 0) return;
		const targetIdx = Math.max(0, Math.min(col.length - 1, idx + delta));
		const target = col[targetIdx];
		if (target && target !== col[idx]) selectItem(target);
	}

	function jumpEdge(edge: 'first' | 'last'): void {
		const col = listColumnItems();
		if (col.length === 0) return;
		const target = edge === 'first' ? col[0] : col[col.length - 1];
		if (target) selectItem(target);
	}

	function navigate(direction: Direction): boolean {
		if (!selectedPos || items.length === 0) return trap;
		const target = findItemInDirection(items, selectedPos, direction);
		if (target) {
			selectItem(target);
			return true;
		}
		return trap; // trap: block navigation from leaving
	}

	// Area handlers for useArea
	const areaHandlers = {
		up: () => navigate('up'),
		down() {
			if (navigate('down')) return true;
			if (onDown) {
				const target = onDown();
				if (target) {
					activateArea(target);
					return true;
				}
			}
			return trap;
		},
		left: () => navigate('left'),
		right: () => navigate('right'),
		confirmDown() {
			pressed = true;
			currentItem()?.onPress?.();
		},
		confirmUp() {
			pressed = false;
			currentItem()?.onConfirm?.();
		},
		confirmCancel() {
			pressed = false;
			currentItem()?.onRelease?.();
		},
		back() {
			onBack?.();
		},
		pageUp() {
			jumpBy(-PAGE_SIZE);
		},
		pageDown() {
			jumpBy(PAGE_SIZE);
		},
		home() {
			jumpEdge('first');
		},
		end() {
			jumpEdge('last');
		},
		onActivate() {
			onAreaActivate?.();
			if (!selectedPos && items.length > 0) selectFirst();
			else if (selectedPos) {
				const item = currentItem();
				if (item) {
					scrollToNavItem(item);
					item.onActivate?.();
				}
			}
		},
	};

	// Controller exposed via context
	const controller: NavAreaController = {
		register(item: NavItem): () => void {
			items.push(item);
			const binding: NavItemBinding = { controller, item };
			allBindings.add(binding);
			if (items.length === 1 && !selectedPos) selectedPos = item.pos;
			return () => {
				allBindings.delete(binding);
				const idx = items.indexOf(item);
				if (idx !== -1) items.splice(idx, 1);
				if (selectedPos && item.pos[0] === selectedPos[0] && item.pos[1] === selectedPos[1]) {
					if (items.length === 0) selectedPos = null;
					else {
						// Move selection to the nearest remaining item
						const left = findItemInDirection(items, selectedPos, 'left');
						const up = findItemInDirection(items, selectedPos, 'up');
						const right = findItemInDirection(items, selectedPos, 'right');
						const down = findItemInDirection(items, selectedPos, 'down');
						const fallback = left || up || right || down || items[0]!;
						selectedPos = fallback.pos;
					}
				}
			};
		},
		isSelected(pos: NavPos): boolean {
			return isAreaActive && selectedPos !== null && pos[0] === selectedPos[0] && pos[1] === selectedPos[1];
		},
		isYSelected(y: number): boolean {
			return isAreaActive && selectedPos !== null && selectedPos[1] === y;
		},
		select(pos: NavPos): void {
			selectedPos = pos;
		},
		isPressed(pos: NavPos): boolean {
			return isAreaActive && pressed && selectedPos !== null && pos[0] === selectedPos[0] && pos[1] === selectedPos[1];
		},
		get areaID() {
			return areaID;
		},
	};

	setContext<NavAreaController>('navArea', controller);

	// Dynamic area management
	let unregArea: (() => void) | null = null;
	let unsubActiveArea: (() => void) | null = null;

	function registerArea(): void {
		unsubActiveArea = activeArea.subscribe(a => {
			isAreaActive = a === areaID;
		});
		unregArea = useArea(areaID, areaHandlers, position);
	}

	function unregisterArea(): void {
		unregArea?.();
		unregArea = null;
		unsubActiveArea?.();
		unsubActiveArea = null;
		isAreaActive = false;
	}

	const handle: NavAreaHandle = {
		pause() {
			unregisterArea();
		},
		resume() {
			registerArea();
		},
		get controller() {
			return controller;
		},
	};

	onMount(() => {
		registerArea();
		if (activate) activateArea(areaID);
		return () => unregisterArea();
	});

	return handle;
}
