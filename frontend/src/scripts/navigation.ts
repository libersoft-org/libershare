import { writable, derived, get } from 'svelte/store';
import { menuStructure, type MenuItem, type MenuAction, type MenuStructure } from './menu.ts';
import { executeBackHandler } from './focus.ts';
import { t } from './language.ts';
// Base breadcrumb path from menu navigation
const baseBreadcrumbStore = writable<string[]>([]);
// Additional breadcrumb items pushed by components (for sub-navigation)
const extraBreadcrumbStore = writable<string[]>([]);
// Derived breadcrumb with translated Home + base + extra
export const breadcrumbItems = derived([baseBreadcrumbStore, extraBreadcrumbStore, t], ([$base, $extra, $t]) => [$t.common?.home, ...$base, ...$extra]);
// Content scroll management
let contentElement: HTMLElement | null = null;
const confirmDialogStore = writable<ConfirmDialogState>({ visible: false, action: null });
// Global navigation store - set by createNavigation, used by components
let globalNavigate: ((id: string) => void) | null = null;

// Internal function to set base breadcrumb (used by navigation system)
function setBaseBreadcrumb(items: string[]): void {
	baseBreadcrumbStore.set(items);
	// Clear extra items when base changes (navigating to different menu item)
	extraBreadcrumbStore.set([]);
}

// Public function for components to push extra breadcrumb items
export function pushBreadcrumb(item: string): void {
	extraBreadcrumbStore.update(items => [...items, item]);
}

// Public function for components to pop extra breadcrumb items
export function popBreadcrumb(): void {
	extraBreadcrumbStore.update(items => (items.length > 0 ? items.slice(0, -1) : items));
}

// Reset all breadcrumbs
export function resetBreadcrumb(): void {
	baseBreadcrumbStore.set([]);
	extraBreadcrumbStore.set([]);
}

// @deprecated - use setBaseBreadcrumb internally
export function setBreadcrumb(items: string[]): void {
	setBaseBreadcrumb(items);
}

export function setContentElement(element: HTMLElement): void {
	contentElement = element;
}

export function scrollContentToTop(): void {
	if (contentElement) contentElement.scrollTo({ top: 0, behavior: 'instant' });
}

// Confirm dialog state
export interface ConfirmDialogState {
	visible: boolean;
	action: MenuAction | null;
}

export const confirmDialog = {
	subscribe: confirmDialogStore.subscribe,
};

export function showConfirmDialog(action: MenuAction): void {
	confirmDialogStore.set({ visible: true, action });
}

export function hideConfirmDialog(): void {
	confirmDialogStore.set({ visible: false, action: null });
}

export function navigateTo(id: string): void {
	if (globalNavigate) globalNavigate(id);
}

// Helper to find menu item by path of IDs
function findItemByPath(structure: MenuStructure, pathIds: string[]): MenuItem | null {
	let items: MenuItem[] = structure.items;
	let item: MenuItem | null = null;
	for (const id of pathIds) {
		item = items.find((i: MenuItem) => i.id === id) ?? null;
		if (!item) return null;
		items = (item.submenu ?? []) as MenuItem[];
	}
	return item;
}

// Helper to get items at current path
function getItemsAtPath(structure: MenuStructure, pathIds: string[]): MenuItem[] {
	if (pathIds.length === 0) return structure.items;
	const item = findItemByPath(structure, pathIds);
	return (item?.submenu ?? []) as MenuItem[];
}

export function createNavigation() {
	// Store only IDs, not full items
	const pathIDs = writable<string[]>([]);
	const selectedId = writable<string | undefined>(undefined);
	// Derived stores that react to both pathIds and menuStructure changes
	const currentItems = derived([pathIDs, menuStructure], ([$pathIds, $menuStructure]) => getItemsAtPath($menuStructure, $pathIds));
	const currentItem = derived([pathIDs, menuStructure], ([$pathIds, $menuStructure]) => ($pathIds.length > 0 ? findItemByPath($menuStructure, $pathIds) : null));
	const currentComponent = derived(currentItem, $item => ($item && $item.component ? $item : null));
	const currentTitle = derived([currentItem, menuStructure], ([$item, $menuStructure]) => ($item ? $item.label : $menuStructure.title));
	const currentOrientation = derived(currentItem, $item => $item?.orientation ?? 'horizontal');
	// Update breadcrumb when path or language changes
	derived([pathIDs, menuStructure], ([$pathIds, $menuStructure]) => {
		const labels: string[] = [];
		let items: MenuItem[] = $menuStructure.items;
		for (const id of $pathIds) {
			const item = items.find((i: MenuItem) => i.id === id);
			if (item) {
				labels.push(item.label || '');
				items = (item.submenu ?? []) as MenuItem[];
			}
		}
		setBreadcrumb(labels);
		return labels;
	}).subscribe(() => {}); // Subscribe to activate the derived store

	function navigate(id: string): void {
		const items = get(currentItems);
		const item = items.find((i: MenuItem) => i.id === id);
		if (!item) return;
		if (item.action === 'back') {
			onBack();
			return;
		}
		// Check if this is a confirm action (restart, shutdown, quit)
		if (item.action && ['restart', 'shutdown', 'quit'].includes(item.action)) {
			showConfirmDialog(item.action);
			return;
		}
		// If item has onSelect callback, call it and navigate back
		if (item.onSelect) {
			item.onSelect();
			onBack();
			return;
		}
		// Navigate into submenu - find selected item if any
		pathIDs.update(p => [...p, id]);
		const newItems = get(currentItems);
		const selectedItem = newItems.find((i: MenuItem) => i.selected?.());
		selectedId.set(selectedItem?.id);
	}

	function navigateBack(): void {
		const currentPathIds = get(pathIDs);
		if (currentPathIds.length > 0) {
			selectedId.set(currentPathIds[currentPathIds.length - 1]);
			pathIDs.update(p => p.slice(0, -1));
		} else {
			const $menuStructure = get(menuStructure);
			const exitItem = $menuStructure.items.find(i => i.id === 'exit');
			if (exitItem) pathIDs.set(['exit']);
		}
	}

	function onBack(): void {
		// If there's a custom back handler on the stack, use it
		if (!executeBackHandler()) navigateBack();
	}

	function reset(): void {
		pathIDs.set([]);
		selectedId.set(undefined);
		resetBreadcrumb();
	}

	// Set global navigate function so components can use navigateTo()
	globalNavigate = navigate;

	return {
		path: pathIDs,
		selectedId,
		currentItems,
		currentComponent,
		currentTitle,
		currentOrientation,
		navigate,
		onBack,
		navigateBack,
		reset,
	};
}

export type Navigation = ReturnType<typeof createNavigation>;
