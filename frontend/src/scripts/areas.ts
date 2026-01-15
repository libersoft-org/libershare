import { writable, get } from 'svelte/store';
import { play } from './audio.ts';
// Types
export type Position = { x: number; y: number };
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
// Internal handlers map
const areaHandlers = new Map<string, AreaHandlers>();
let confirmActive = false;

// Layout management
export function setAreaPosition(areaID: string, position: Position): void {
	areaLayout.update(layout => ({ ...layout, [areaID]: position }));
}

export function removeArea(areaID: string): void {
	areaLayout.update(layout => {
		const { [areaID]: _, ...rest } = layout;
		return rest;
	});
	areaHandlers.delete(areaID);
	if (get(activeArea) === areaID) activeArea.set(null);
}

export function clearLayout(): void {
	areaLayout.set({});
	areaHandlers.clear();
	activeArea.set(null);
}

// Handler management - called by components
export function useArea(areaID: string, handlers: AreaHandlers): () => void {
	areaHandlers.set(areaID, handlers);
	return () => areaHandlers.delete(areaID);
}

// Activation
export function activateArea(areaID: string): void {
	const layout = get(areaLayout);
	if (areaID in layout) {
		activeArea.set(areaID);
		const handlers = areaHandlers.get(areaID);
		handlers?.onActivate?.();
	}
}

// Navigation
export function areaNavigate(direction: Direction): boolean {
	const layout = get(areaLayout);
	const current = get(activeArea);
	if (!current || !(current in layout)) return false;
	const currentPos = layout[current];
	const target = findAreaInDirection(layout, currentPos, direction);
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
		// Vertical - find closest on target Y
		const targetY = direction === 'up' ? y - 1 : y + 1;
		// First try exact X match
		for (const [id, pos] of Object.entries(layout)) {
			if (pos.x === x && pos.y === targetY) return id;
		}
		// If no exact match, find closest X on target Y
		let closest: string | null = null;
		let closestDistance = Infinity;
		for (const [id, pos] of Object.entries(layout)) {
			if (pos.y === targetY) {
				const distance = Math.abs(pos.x - x);
				if (distance < closestDistance) {
					closestDistance = distance;
					closest = id;
				}
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
	if (directionHandler) {
		const handled = directionHandler();
		if (!handled) areaNavigate(action as Direction);
	} else areaNavigate(action as Direction);
	play('move');
}
