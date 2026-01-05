import { writable } from 'svelte/store';

export type InputAction = 'up' | 'down' | 'left' | 'right' | 'confirmDown' | 'confirmUp' | 'confirmCancel' | 'back';
export type InputCallback = () => void;
export type InputHandlers = Partial<Record<InputAction, InputCallback>>;
interface AreaEntry {
	handlers: InputHandlers;
	order: number;
}
const activeAreaStore = writable<string | null>(null);
export const activeArea = { subscribe: activeAreaStore.subscribe };

class AreaManager {
	private areas: Map<string, AreaEntry> = new Map();
	private activeAreaId: string | null = null;
	private confirmActive = false;
	private nextOrder = 0;

	registerArea(areaID: string, handlers: InputHandlers): () => void {
		this.areas.set(areaID, { handlers, order: this.nextOrder++ });
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

	activatePrevArea(): boolean {
		if (!this.activeAreaId) return false;
		const currentEntry = this.areas.get(this.activeAreaId);
		if (!currentEntry) return false;
		let prevArea: string | null = null;
		let prevOrder = -1;
		for (const [id, entry] of this.areas) {
			if (entry.order < currentEntry.order && entry.order > prevOrder) {
				prevArea = id;
				prevOrder = entry.order;
			}
		}
		if (prevArea) {
			this.activeAreaId = prevArea;
			activeAreaStore.set(prevArea);
			return true;
		}
		return false;
	}

	activateNextArea(): boolean {
		if (!this.activeAreaId) return false;
		const currentEntry = this.areas.get(this.activeAreaId);
		if (!currentEntry) return false;
		let nextArea: string | null = null;
		let nextOrder = Infinity;
		for (const [id, entry] of this.areas) {
			if (entry.order > currentEntry.order && entry.order < nextOrder) {
				nextArea = id;
				nextOrder = entry.order;
			}
		}
		if (nextArea) {
			this.activeAreaId = nextArea;
			activeAreaStore.set(nextArea);
			return true;
		}
		return false;
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

export function registerArea(areaID: string, handlers: InputHandlers): () => void {
	return getAreaManager().registerArea(areaID, handlers);
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

export function emit(action: InputAction): void {
	getAreaManager().emit(action);
}
