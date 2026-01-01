import { writable, derived, get } from 'svelte/store';
import type { Component } from 'svelte';
import Items from '../components/Items.svelte';

export interface MenuItem {
	id: string;
	label: string;
	submenu?: MenuItem[];
	component?: Component<any>;
	props?: Record<string, any>;
	action?: 'back';
	orientation?: 'horizontal' | 'vertical';
}

export const menuStructure: MenuItem[] = [
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
];

export function createNavigation() {
	const path = writable<MenuItem[]>([]);
	const selectedId = writable<string | undefined>(undefined);
	const currentItems = derived(path, $path => ($path.length === 0 ? menuStructure : ($path[$path.length - 1].submenu ?? [])));
	const currentComponent = derived(path, $path => ($path.length > 0 && $path[$path.length - 1].component ? $path[$path.length - 1] : null));
	const currentTitle = derived(path, $path => ($path.length === 0 ? 'LiberShare' : $path[$path.length - 1].label));
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
	}

	function goBack(): void {
		const currentPath = get(path);
		if (currentPath.length > 0) {
			selectedId.set(currentPath[currentPath.length - 1].id);
			path.update(p => p.slice(0, -1));
		} else {
			const exitItem = menuStructure.find(i => i.id === 'exit');
			if (exitItem) path.set([exitItem]);
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
		reset,
	};
}

export type Navigation = ReturnType<typeof createNavigation>;
