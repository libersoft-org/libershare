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
}

/** Create a NavItem with reactive pos and el getters */
export function navItem(getPos: () => NavPos, getEl: () => HTMLElement | undefined, onConfirm?: () => void): NavItem {
	return {
		get pos() {
			return getPos();
		},
		get el() {
			return getEl();
		},
		onConfirm,
	};
}

export interface NavAreaController {
	/** Register a navigable item. Returns cleanup function. */
	register(item: NavItem): () => void;
	/** Check if item at given position is the currently selected one */
	isSelected(pos: NavPos): boolean;
	/** Check if item at given position is currently pressed (confirmDown active) */
	isPressed(pos: NavPos): boolean;
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
	item.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
	/** Called when the area is activated */
	onActivate?: (() => void) | undefined;
	/** Called when selected item changes */
	onSelect?: ((pos: NavPos) => void) | undefined;
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
	const { areaID, position, activate = false, trap = false, initialPosition, onBack, onActivate: onAreaActivate, onSelect } = getConfig();

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
		for (const item of items) {
			if (item.pos[1] < best.pos[1] || (item.pos[1] === best.pos[1] && item.pos[0] < best.pos[0])) {
				best = item;
			}
		}
		selectItem(best);
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
		down: () => navigate('down'),
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
			if (items.length === 1 && !selectedPos) {
				selectedPos = item.pos;
			}
			return () => {
				const idx = items.indexOf(item);
				if (idx !== -1) items.splice(idx, 1);
				if (selectedPos && item.pos[0] === selectedPos[0] && item.pos[1] === selectedPos[1]) {
					if (items.length === 0) selectedPos = null;
				}
			};
		},
		isSelected(pos: NavPos): boolean {
			return isAreaActive && selectedPos !== null && pos[0] === selectedPos[0] && pos[1] === selectedPos[1];
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
