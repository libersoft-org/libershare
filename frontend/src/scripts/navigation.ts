import { writable, derived, get } from 'svelte/store';
import { menuStructure, type MenuItem } from './menu.ts';
import { getFocusAreaStore, executeBackHandler } from './focus.ts';

// Re-export commonly used items for convenience
export { focusArea, focusHeader, focusContent, pushBackHandler, setContentScene } from './focus.ts';
export type { FocusArea } from './focus.ts';
export { menuStructure, type MenuItem, type MenuStructure } from './menu.ts';

export function createNavigation() {
	const focusAreaStore = getFocusAreaStore();
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
		if (!executeBackHandler()) {
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
