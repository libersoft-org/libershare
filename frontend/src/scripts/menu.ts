import type { Component } from 'svelte';
import Items from '../components/List/List.svelte';
import { productName } from './app.ts';

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
