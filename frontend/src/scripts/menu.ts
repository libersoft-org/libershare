import type { Component } from 'svelte';
import { derived } from 'svelte/store';
import { productName } from './app.ts';
import { t, tt } from './language.ts';
import Items from '../components/List/List.svelte';
import About from '../components/About/About.svelte';
import Download from '../components/Download/Download.svelte';
import SettingsLanguage from '../components/Settings/SettingsLanguage.svelte';
import SettingsAudio from '../components/Settings/SettingsAudio.svelte';
import SettingsCursor from '../components/Settings/SettingsCursor.svelte';
import SettingsFooter from '../components/Settings/SettingsFooter.svelte';
import ConfirmDialog from '../components/Dialog/ConfirmDialog.svelte';
export type MenuAction = 'back' | 'restart' | 'shutdown' | 'quit';
export interface MenuItem {
	id: string;
	label?: string;
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
// Reactive menu structure - updates when language changes
export const menuStructure = derived(t, () => ({
	title: productName,
	items: [
		{
			id: 'storage',
			label: tt('storage.title'),
			submenu: [
				{ id: 'video', label: 'Video', component: Items, props: { category: 'video' } },
				{ id: 'software', label: 'Software', component: Items, props: { category: 'software' } },
				{ id: 'back', label: tt('common.back'), action: 'back' as const },
			],
		},
		{
			id: 'downloads',
			label: tt('downloads.title'),
			component: Download,
		},
		{
			id: 'settings',
			label: tt('settings.title'),
			orientation: 'horizontal' as const,
			submenu: [
				{ id: 'language', label: tt('settings.language'), component: SettingsLanguage },
				{ id: 'audio', label: tt('settings.audio'), component: SettingsAudio },
				{ id: 'cursor', label: tt('settings.cursorSize'), component: SettingsCursor },
				{ id: 'footer', label: tt('settings.footer'), component: SettingsFooter },
				{ id: 'back', label: tt('common.back'), action: 'back' as const },
			],
		},
		{
			id: 'about',
			label: tt('about.title'),
			component: About,
		},
		{
			id: 'exit',
			label: tt('exit.title'),
			orientation: 'vertical' as const,
			submenu: [
				{ id: 'restart', label: tt('exit.restart.title'), action: 'restart' as const },
				{ id: 'shutdown', label: tt('exit.shutdown.title'), action: 'shutdown' as const },
				{ id: 'quit', label: tt('exit.quitApplication.title'), action: 'quit' as const },
				{ id: 'back', label: tt('common.back'), action: 'back' as const },
			],
		},
	],
}));

// Reactive confirm dialogs
export const confirmDialogs = derived(t, () => ({
	restart: {
		title: tt('exit.restart.title'),
		message: tt('exit.restart.message'),
		apiAction: 'restart',
		confirmLabel: tt('common.yes'),
		cancelLabel: tt('common.no'),
		defaultButton: 'cancel' as const,
	},
	shutdown: {
		title: tt('exit.shutdown.title'),
		message: tt('exit.shutdown.message'),
		apiAction: 'shutdown',
		confirmLabel: tt('common.yes'),
		cancelLabel: tt('common.no'),
		defaultButton: 'cancel' as const,
	},
	quit: {
		title: tt('exit.quitApplication.title'),
		message: tt('exit.quitApplication.message'),
		apiAction: 'quit',
		confirmLabel: tt('common.yes'),
		cancelLabel: tt('common.no'),
		defaultButton: 'cancel' as const,
	},
}));

export { ConfirmDialog };
