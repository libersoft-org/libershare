import { writable } from 'svelte/store';
export type InputAction = 'up' | 'down' | 'left' | 'right' | 'confirmDown' | 'confirmUp' | 'confirmCancel' | 'back';
export type InputCallback = () => void;
export type InputHandlers = Partial<Record<InputAction, InputCallback>>;
export type AreaPosition = { x: number; y: number };
interface AreaEntry {
	handlers: InputHandlers;
	position: AreaPosition;
}
const activeAreaStore = writable<string | null>(null);
export const activeArea = { subscribe: activeAreaStore.subscribe };

class AreaManager {
	private areas: Map<string, AreaEntry> = new Map();
	private activeAreaId: string | null = null;
	private confirmActive = false;

	registerArea(areaID: string, position: AreaPosition, handlers: InputHandlers): () => void {
		this.areas.set(areaID, { handlers, position });
		return () => this.unregisterArea(areaID);
	}

	unregisterArea(areaID: string): void {
		this.areas.delete(areaID);
		if (this.activeAreaId === areaID) {
			this.activeAreaId = null;
			activeAreaStore.set(null);
		}
	}

	activateArea(areaID: string): void {
		if (this.areas.has(areaID)) {
			this.activeAreaId = areaID;
			activeAreaStore.set(areaID);
		}
	}

	deactivateArea(areaID: string): void {
		if (this.activeAreaId === areaID) {
			this.activeAreaId = null;
			activeAreaStore.set(null);
		}
	}

	getActiveArea(): string | null {
		return this.activeAreaId;
	}

	private findClosestArea(targetX: number, targetY: number, excludeId?: string): string | null {
		let closest: string | null = null;
		let closestDistance = Infinity;

		for (const [id, entry] of this.areas) {
			if (id === excludeId) continue;
			const dx = entry.position.x - targetX;
			const dy = entry.position.y - targetY;
			// Prioritize exact match on the search axis, then find closest
			const distance = Math.abs(dx) + Math.abs(dy);
			if (distance < closestDistance) {
				closestDistance = distance;
				closest = id;
			}
		}
		return closest;
	}

	private findAreaInDirection(direction: 'up' | 'down' | 'left' | 'right'): string | null {
		if (!this.activeAreaId) return null;
		const currentEntry = this.areas.get(this.activeAreaId);
		if (!currentEntry) return null;

		const { x, y } = currentEntry.position;

		if (direction === 'left' || direction === 'right') {
			// Horizontal movement - must stay on same Y, find closest X in direction
			let closest: string | null = null;
			let closestX = direction === 'left' ? -Infinity : Infinity;

			for (const [id, entry] of this.areas) {
				if (entry.position.y !== y) continue; // Must be same row
				if (direction === 'left') {
					// Find closest X that is less than current X
					if (entry.position.x < x && entry.position.x > closestX) {
						closestX = entry.position.x;
						closest = id;
					}
				} else {
					// Find closest X that is greater than current X
					if (entry.position.x > x && entry.position.x < closestX) {
						closestX = entry.position.x;
						closest = id;
					}
				}
			}
			return closest;
		} else {
			// Vertical movement (up/down)
			const targetY = direction === 'up' ? y - 1 : y + 1;

			// First try to find exact match on target Y with same X
			for (const [id, entry] of this.areas) {
				if (entry.position.x === x && entry.position.y === targetY) {
					return id;
				}
			}

			// If no exact match, find closest X on the target Y
			let closest: string | null = null;
			let closestDistance = Infinity;

			for (const [id, entry] of this.areas) {
				if (entry.position.y === targetY) {
					const distance = Math.abs(entry.position.x - x);
					if (distance < closestDistance) {
						closestDistance = distance;
						closest = id;
					}
				}
			}
			return closest;
		}
	}

	navigateUp(): boolean {
		const target = this.findAreaInDirection('up');
		if (target) {
			this.activeAreaId = target;
			activeAreaStore.set(target);
			return true;
		}
		return false;
	}

	navigateDown(): boolean {
		const target = this.findAreaInDirection('down');
		if (target) {
			this.activeAreaId = target;
			activeAreaStore.set(target);
			return true;
		}
		return false;
	}

	navigateLeft(): boolean {
		const target = this.findAreaInDirection('left');
		if (target) {
			this.activeAreaId = target;
			activeAreaStore.set(target);
			return true;
		}
		return false;
	}

	navigateRight(): boolean {
		const target = this.findAreaInDirection('right');
		if (target) {
			this.activeAreaId = target;
			activeAreaStore.set(target);
			return true;
		}
		return false;
	}

	// Legacy methods for backward compatibility
	activatePrevArea(): boolean {
		return this.navigateUp();
	}

	activateNextArea(): boolean {
		return this.navigateDown();
	}

	emit(action: InputAction): void {
		if (!this.activeAreaId) return;
		const entry = this.areas.get(this.activeAreaId);
		const handlers = entry?.handlers;

		// Handle confirm state
		if (action === 'confirmDown') this.confirmActive = true;
		else if (action === 'confirmUp') {
			if (!this.confirmActive) return;
			this.confirmActive = false;
		} else if (action === 'confirmCancel') this.confirmActive = false;
		else {
			if (this.confirmActive) {
				this.confirmActive = false;
				const cancelCallback = handlers?.['confirmCancel'];
				if (cancelCallback) cancelCallback();
			}
		}
		const callback = handlers?.[action];
		if (callback) callback();
	}
}

let globalAreaManager: AreaManager | null = null;

export function getAreaManager(): AreaManager {
	if (!globalAreaManager) globalAreaManager = new AreaManager();
	return globalAreaManager;
}

export function registerArea(areaID: string, position: AreaPosition, handlers: InputHandlers): () => void {
	return getAreaManager().registerArea(areaID, position, handlers);
}

export function unregisterArea(areaID: string): void {
	getAreaManager().unregisterArea(areaID);
}

export function activateArea(areaID: string): void {
	getAreaManager().activateArea(areaID);
}

export function deactivateArea(areaID: string): void {
	getAreaManager().deactivateArea(areaID);
}

export function activatePrevArea(): boolean {
	return getAreaManager().activatePrevArea();
}

export function activateNextArea(): boolean {
	return getAreaManager().activateNextArea();
}

export function navigateUp(): boolean {
	return getAreaManager().navigateUp();
}

export function navigateDown(): boolean {
	return getAreaManager().navigateDown();
}

export function navigateLeft(): boolean {
	return getAreaManager().navigateLeft();
}

export function navigateRight(): boolean {
	return getAreaManager().navigateRight();
}

export function emit(action: InputAction): void {
	getAreaManager().emit(action);
}
