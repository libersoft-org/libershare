import type { Component } from 'svelte';
import Items from '../components/List/List.svelte';
import About from '../components/About/About.svelte';
import Download from '../components/Download/Download.svelte';
import Settings from '../components/Settings/Settings.svelte';
import ConfirmDialog from '../components/Dialog/ConfirmDialog.svelte';
import { productName } from './app.ts';
export type MenuAction = 'back' | 'restart' | 'shutdown' | 'quit';
export interface MenuItem {
	id: string;
	label: string;
	submenu?: MenuItem[];
	component?: Component<any>;
	props?: Record<string, any>;
	action?: MenuAction;
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
			component: Download,
		},
		{
			id: 'settings',
			label: 'Settings',
			component: Settings,
		},
		{
			id: 'about',
			label: 'About',
			component: About,
		},
		{
			id: 'exit',
			label: 'Exit',
			orientation: 'vertical',
			submenu: [
				{ id: 'restart', label: 'Restart', action: 'restart' },
				{ id: 'shutdown', label: 'Shutdown', action: 'shutdown' },
				{ id: 'quit', label: 'Quit application', action: 'quit' },
				{ id: 'back', label: 'Back', action: 'back' },
			],
		},
	],
};

export const confirmDialogs: Record<string, { title: string; message: string; apiAction: string; confirmLabel: string; cancelLabel: string; defaultButton: 'confirm' | 'cancel' }> = {
	restart: {
		title: 'Restart',
		message: 'Are you sure you want to restart the device?',
		apiAction: 'restart',
		confirmLabel: 'Yes',
		cancelLabel: 'No',
		defaultButton: 'cancel',
	},
	shutdown: {
		title: 'Shutdown',
		message: 'Are you sure you want to shutdown the device?',
		apiAction: 'shutdown',
		confirmLabel: 'Yes',
		cancelLabel: 'No',
		defaultButton: 'cancel',
	},
	quit: {
		title: 'Quit application',
		message: 'Are you sure you want to quit the application?',
		apiAction: 'quit',
		confirmLabel: 'Yes',
		cancelLabel: 'No',
		defaultButton: 'cancel',
	},
};

export { ConfirmDialog };
