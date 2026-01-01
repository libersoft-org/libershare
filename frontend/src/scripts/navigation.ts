import { writable, derived, get } from 'svelte/store';
import type { Component } from 'svelte';
import Items from '../components/List/List.svelte';
import { productName } from './app.ts';
import { activateScene, getInputManager } from './input.ts';
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
	const currentScene = getInputManager().getActiveScene();
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

export interface MenuItem {
	id: string;
	label: string;
	submenu?: MenuItem[];
	component?: Component<any>;
	props?: Record<string, any>;
	action?: 'back';
	orientation?: 'horizontal' | 'vertical';
}

export interface MenuStructure {
	title: string;
	items: MenuItem[];
}

export const menuStructure: MenuStructure = {
	title: productName,
	items: [
		{
			id: 'storage',
			label: 'Storage',
			submenu: [
				{ id: 'movies', label: 'Movies', component: Items, props: { category: 'movies' } },
				{ id: 'series', label: 'Series', component: Items, props: { category: 'series' } },
				{ id: 'music', label: 'Music', component: Items, props: { category: 'music' } },
				{ id: 'back', label: 'Back', action: 'back' },
			],
		},
		{
			id: 'downloads',
			label: 'Downloads',
			submenu: [{ id: 'back', label: 'Back', action: 'back' }],
		},
		{
			id: 'settings',
			label: 'Settings',
			submenu: [{ id: 'back', label: 'Back', action: 'back' }],
		},
		{
			id: 'about',
			label: 'About',
			submenu: [{ id: 'back', label: 'Back', action: 'back' }],
		},
		{
			id: 'exit',
			label: 'Exit',
			orientation: 'vertical',
			submenu: [
				{ id: 'back', label: 'Back', action: 'back' },
				{ id: 'restart', label: 'Restart' },
				{ id: 'shutdown', label: 'Shutdown' },
				{ id: 'exit-app', label: 'Exit Application' },
			],
		},
	],
};

export function createNavigation() {
	const path = writable<MenuItem[]>([]);
	const selectedId = writable<string | undefined>(undefined);
	const currentItems = derived(path, $path => ($path.length === 0 ? menuStructure.items : ($path[$path.length - 1].submenu ?? [])));
	const currentComponent = derived(path, $path => ($path.length > 0 && $path[$path.length - 1].component ? $path[$path.length - 1] : null));
	const currentTitle = derived(path, $path => ($path.length === 0 ? menuStructure.title : $path[$path.length - 1].label));
	const currentOrientation = derived(path, $path => ($path.length > 0 ? ($path[$path.length - 1].orientation ?? 'horizontal') : 'horizontal'));

	function navigate(id: string): void {
		const items = get(currentItems);
		const item = items.find(i => i.id === id);
		if (!item) return;
		if (item.action === 'back') {
			goBack();
			return;
		}
		selectedId.set(undefined);
		path.update(p => [...p, item]);
		focusAreaStore.set('content');
	}

	function navigateBack(): void {
		const currentPath = get(path);
		if (currentPath.length > 0) {
			selectedId.set(currentPath[currentPath.length - 1].id);
			path.update(p => p.slice(0, -1));
		} else {
			const exitItem = menuStructure.items.find(i => i.id === 'exit');
			if (exitItem) path.set([exitItem]);
		}
		focusAreaStore.set('content');
	}

	function goBack(): void {
		// If there's a custom back handler on the stack, use it
		if (backStack.length > 0) {
			const handler = backStack[backStack.length - 1];
			handler();
		} else {
			navigateBack();
		}
	}

	function reset(): void {
		path.set([]);
		selectedId.set(undefined);
	}

	return {
		path,
		selectedId,
		currentItems,
		currentComponent,
		currentTitle,
		currentOrientation,
		navigate,
		goBack,
		navigateBack,
		reset,
	};
}

export type Navigation = ReturnType<typeof createNavigation>;
