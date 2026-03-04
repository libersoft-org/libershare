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
	/** Activate this area on mount */
	activate?: boolean;
	onBack?: (() => void) | undefined;
	/** Called when selected item changes */
	onSelect?: ((pos: NavPos) => void) | undefined;
}

/**
 * Create a declarative navigation area. Call this in a component's top-level script.
 * Sets up context for child components (Button, NavItem, etc.) to register into.
 *
 * @param areaID - Unique identifier for the area
 * @param position - Position in the spatial area layout
 * @param options - Optional callbacks and settings
 */
export function createNavArea(areaID: string, position: Position, options: NavAreaOptions = {}): void {
	const { activate = false, onBack, onSelect } = options;

	// Reactive state (runes work in .svelte.ts)
	let items: NavItem[] = [];
	let selectedPos = $state<NavPos | null>(null);
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
		if (!selectedPos || items.length === 0) return false;
		const target = findItemInDirection(items, selectedPos, direction);
		if (target) {
			selectItem(target);
			return true;
		}
		return false;
	}

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
					if (items.length > 0) selectFirst();
					else selectedPos = null;
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

	onMount(() => {
		const unsubActiveArea = activeArea.subscribe(a => {
			isAreaActive = a === areaID;
		});

		const unregister = useArea(
			areaID,
			{
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
					if (!selectedPos && items.length > 0) selectFirst();
					else if (selectedPos) currentItem()?.onActivate?.();
				},
			},
			position
		);
		if (activate) activateArea(areaID);
		return () => {
			unregister();
			unsubActiveArea();
		};
	});
}
