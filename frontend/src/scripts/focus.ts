import { writable } from 'svelte/store';
import { activateArea, getAreaManager } from './areas.ts';

export type FocusArea = 'header' | 'content';

const focusAreaStore = writable<FocusArea>('content');
let lastContentArea: string | null = null;

// Back handler stack
type BackHandler = () => void;
const backStack: BackHandler[] = [];

export function pushBackHandler(handler: BackHandler): () => void {
	backStack.push(handler);
	return () => {
		const index = backStack.indexOf(handler);
		if (index !== -1) backStack.splice(index, 1);
	};
}

export function popBackHandler(): BackHandler | undefined {
	return backStack.pop();
}

export function hasBackHandler(): boolean {
	return backStack.length > 0;
}

export function executeBackHandler(): boolean {
	if (backStack.length > 0) {
		const handler = backStack[backStack.length - 1];
		handler();
		return true;
	}
	return false;
}

// Subscribe to focusArea changes and activate appropriate area
focusAreaStore.subscribe(area => {
	if (area === 'header') {
		activateArea('header');
	} else if (lastContentArea) {
		activateArea(lastContentArea);
	}
});

export const focusArea = {
	subscribe: focusAreaStore.subscribe,
	set: focusAreaStore.set,
};

export function focusHeader(): void {
	// Remember current content area before switching to header
	const currentArea = getAreaManager().getActiveArea();
	if (currentArea && currentArea !== 'header') {
		lastContentArea = currentArea;
	}
	focusAreaStore.set('header');
}

export function focusContent(): void {
	focusAreaStore.set('content');
	if (lastContentArea) {
		activateArea(lastContentArea);
	}
}

export function setContentArea(areaID: string): void {
	lastContentArea = areaID;
}

// Internal access for navigation
export function getFocusAreaStore() {
	return focusAreaStore;
}
