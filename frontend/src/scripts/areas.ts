import { writable, get } from 'svelte/store';
import { play } from './audio.ts';
import { type Position } from './navigationLayout.ts';
// Types
export type Direction = 'up' | 'down' | 'left' | 'right';
export type InputAction = Direction | 'confirmDown' | 'confirmUp' | 'confirmCancel' | 'back';
export type AreaHandlers = {
	up?: () => boolean;
	down?: () => boolean;
	left?: () => boolean;
	right?: () => boolean;
	confirmDown?: () => void;
	confirmUp?: () => void;
	confirmCancel?: () => void;
	back?: () => void;
	onActivate?: () => void;
};
// Stores
export const areaLayout = writable<Record<string, Position>>({});
export const activeArea = writable<string | null>(null);
export const debugAreas = writable<boolean>(false); // Debug mode - when true, shows area overlay
// Internal handlers map
const areaHandlers = new Map<string, AreaHandlers>();
let confirmActive = false;

// Clear all areas (used on navigation/page change)
export function clearLayout(): void {
	areaLayout.set({});
	areaHandlers.clear();
	activeArea.set(null);
}

/**
 * Register an area with handlers and position.
 * This is the ONLY way to register areas - ensures consistency.
 *
 * @param areaID - Unique identifier for the area
 * @param handlers - Navigation handlers for this area
 * @param position - Position in the spatial layout (required)
 * @returns Cleanup function that removes the area
 */
export function useArea(areaID: string, handlers: AreaHandlers, position: Position): () => void {
	// Register handlers
	areaHandlers.set(areaID, handlers);
	// Register position
	areaLayout.update(layout => ({ ...layout, [areaID]: position }));
	// Return cleanup function - only unregister if our handlers are still the active ones
	// (prevents race conditions when components sharing the same areaID overlap during transitions)
	return () => {
		if (areaHandlers.get(areaID) === handlers) {
			areaHandlers.delete(areaID);
			areaLayout.update(layout => {
				const { [areaID]: _, ...rest } = layout;
				return rest;
			});
			if (get(activeArea) === areaID) activeArea.set(null);
		}
	};
}

// Activation
export function activateArea(areaID: string): void {
	const handlers = areaHandlers.get(areaID);
	if (handlers) {
		activeArea.set(areaID);
		handlers.onActivate?.();
	}
}

// Navigation
export function areaNavigate(direction: Direction): boolean {
	const layout = get(areaLayout);
	const current = get(activeArea);
	console.log(
		'areaNavigate',
		direction,
		'from',
		current,
		'layout:',
		Object.keys(layout)
			.map(k => `${k}:${JSON.stringify(layout[k])}`)
			.join(', ')
	);
	if (!current || !(current in layout)) {
		console.log('areaNavigate: current area not in layout');
		return false;
	}
	const currentPos = layout[current]!;
	const target = findAreaInDirection(layout, currentPos, direction);
	console.log('areaNavigate: target', target);
	if (target) {
		activateArea(target);
		return true;
	}
	return false;
}

function findAreaInDirection(layout: Record<string, Position>, currentPos: Position, direction: Direction): string | null {
	const { x, y } = currentPos;
	if (direction === 'left' || direction === 'right') {
		// Horizontal - must stay on same Y, find closest X in direction
		let closest: string | null = null;
		let closestX = direction === 'left' ? -Infinity : Infinity;
		for (const [id, pos] of Object.entries(layout)) {
			if (pos.y !== y) continue;
			if (direction === 'left') {
				if (pos.x < x && pos.x > closestX) {
					closestX = pos.x;
					closest = id;
				}
			} else {
				if (pos.x > x && pos.x < closestX) {
					closestX = pos.x;
					closest = id;
				}
			}
		}
		return closest;
	} else {
		// Vertical - find closest Y in direction, then closest X
		let closest: string | null = null;
		let closestY = direction === 'up' ? -Infinity : Infinity;
		let closestDistance = Infinity;
		for (const [id, pos] of Object.entries(layout)) {
			const validDirection = direction === 'up' ? pos.y < y : pos.y > y;
			if (!validDirection) continue;
			const betterY = direction === 'up' ? pos.y > closestY : pos.y < closestY;
			const sameY = pos.y === closestY;
			const distance = Math.abs(pos.x - x);
			if (betterY || (sameY && distance < closestDistance)) {
				closestY = pos.y;
				closestDistance = distance;
				closest = id;
			}
		}
		return closest;
	}
}

// Input emission - called by input system
export function emit(action: InputAction): void {
	const current = get(activeArea);
	if (!current) return;
	const handlers = areaHandlers.get(current);
	if (!handlers) return;
	// Handle confirm state
	if (action === 'confirmDown') {
		confirmActive = true;
		handlers.confirmDown?.();
		return;
	}
	if (action === 'confirmUp') {
		if (!confirmActive) return;
		confirmActive = false;
		play('confirm');
		handlers.confirmUp?.();
		return;
	}
	if (action === 'confirmCancel') {
		confirmActive = false;
		handlers.confirmCancel?.();
		return;
	}
	if (action === 'back') {
		if (confirmActive) {
			confirmActive = false;
			handlers.confirmCancel?.();
		}
		play('back');
		handlers.back?.();
		return;
	}
	// Direction actions
	if (confirmActive) {
		confirmActive = false;
		handlers.confirmCancel?.();
	}
	const directionHandler = handlers[action as Direction];
	// Handler returns true only if it actually handled the navigation (moved to next item inside)
	// If handler returns false or doesn't exist, automatically navigate to next area
	const handled = directionHandler ? directionHandler() : false;
	if (!handled) {
		const navigated = areaNavigate(action as Direction);
		// Only play move sound if we actually moved somewhere
		if (navigated) play('move');
	} else {
		play('move');
	}
}
