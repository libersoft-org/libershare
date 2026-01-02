import { writable } from 'svelte/store';
import { activateScene, getSceneManager } from './scenes.ts';

export type FocusArea = 'header' | 'content';

const focusAreaStore = writable<FocusArea>('content');
let lastContentScene: string | null = null;

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

// Subscribe to focusArea changes and activate appropriate scene
focusAreaStore.subscribe(area => {
	if (area === 'header') {
		activateScene('header');
	} else if (lastContentScene) {
		activateScene(lastContentScene);
	}
});

export const focusArea = {
	subscribe: focusAreaStore.subscribe,
	set: focusAreaStore.set,
};

export function focusHeader(): void {
	// Remember current content scene before switching to header
	const currentScene = getSceneManager().getActiveScene();
	if (currentScene && currentScene !== 'header') {
		lastContentScene = currentScene;
	}
	focusAreaStore.set('header');
}

export function focusContent(): void {
	focusAreaStore.set('content');
	if (lastContentScene) {
		activateScene(lastContentScene);
	}
}

export function setContentScene(sceneId: string): void {
	lastContentScene = sceneId;
}

// Internal access for navigation
export function getFocusAreaStore() {
	return focusAreaStore;
}
