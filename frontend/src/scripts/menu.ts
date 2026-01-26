import type { Component } from 'svelte';
import { derived, get } from 'svelte/store';
import { productName } from './app.ts';
import { t, tt, currentLanguage, setLanguage, languages } from './language.ts';
import { audioEnabled, setAudioEnabled, cursorSize, setCursorSize, type CursorSize, timeFormat, setTimeFormat, showSeconds, setShowSeconds } from './settings.ts';
import { footerPosition, setFooterPosition } from './settings.ts';
import type { FooterPosition } from './footerWidgets.ts';
import Items from '../components/List/List.svelte';
import Categories from '../components/Categories/Categories.svelte';
import Storage from '../components/Storage/Storage.svelte';
import Download from '../components/Download/Download.svelte';
import DownloadLISHCreate from '../components/Download/DownloadLISHCreate.svelte';
import DownloadLISHImport from '../components/Download/DownloadLISHImport.svelte';
import DownloadLISHImportBrowse from '../components/Download/DownloadLISHImportBrowse.svelte';
import DownloadLISHExportAll from '../components/Download/DownloadLISHExportAll.svelte';
import SettingsFooter from '../components/Settings/SettingsFooter.svelte';
import SettingsStorage from '../components/Settings/SettingsStorage.svelte';
import LISHNetworkList from '../components/Settings/SettingsLISHNetworkList.svelte';
import About from '../components/About/About.svelte';
export type MenuAction = 'back' | 'restart' | 'shutdown' | 'quit';
export interface MenuItem {
	id: string;
	label?: string;
	icon?: string;
	iconPosition?: 'left' | 'top';
	iconSize?: string;
	submenu?: MenuItem[];
	component?: Component<any>;
	props?: Record<string, any>;
	action?: MenuAction;
	orientation?: 'horizontal' | 'vertical';
	onSelect?: () => void;
	selected?: () => boolean;
	hidden?: boolean; // Hidden from menu but navigable programmatically
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
			id: 'library',
			label: tt('library.title'),
			icon: '/img/online.svg',
			component: Categories,
			submenu: [
				{
					id: 'video',
					label: 'Video',
					iconPosition: 'left',
					iconSize: '2vh',
					component: Items,
					props: {
						category: 'video',
					},
				},
				{
					id: 'software',
					label: 'Software',
					iconPosition: 'left',
					iconSize: '2vh',
					component: Items,
					props: {
						category: 'software',
					},
				},
				{
					id: 'back',
					label: tt('common.back'),
					icon: '/img/back.svg',
					iconPosition: 'left',
					iconSize: '2vh',
					action: 'back' as const,
				},
			],
		},
		{
			id: 'localStorage',
			label: tt('localStorage.title'),
			icon: '/img/folder.svg',
			component: Storage,
		},
		{
			id: 'downloads',
			label: tt('downloads.title'),
			icon: '/img/download.svg',
			component: Download,
			submenu: [
				{
					id: 'create-lish',
					label: tt('downloads.createLish'),
					icon: '/img/plus.svg',
					iconPosition: 'left',
					iconSize: '2vh',
					component: DownloadLISHCreate,
				},
				{
					id: 'import-lish',
					label: tt('common.import'),
					icon: '/img/download.svg',
					iconPosition: 'left',
					iconSize: '2vh',
					component: DownloadLISHImport,
					submenu: [
						{
							id: 'import-lish-browse',
							label: tt('common.selectFile'),
							component: DownloadLISHImportBrowse,
							hidden: true,
						},
					],
				},
				{
					id: 'export-all-lish',
					label: tt('common.exportAll'),
					icon: '/img/upload.svg',
					iconPosition: 'left',
					iconSize: '2vh',
					component: DownloadLISHExportAll,
				},
				{
					id: 'back',
					label: tt('common.back'),
					icon: '/img/back.svg',
					iconPosition: 'left',
					iconSize: '2vh',
					action: 'back' as const,
				},
			],
		},
		{
			id: 'settings',
			label: tt('settings.title'),
			icon: '/img/settings.svg',
			orientation: 'horizontal' as const,
			submenu: [
				{
					id: 'localStorage',
					label: tt('localStorage.title'),
					icon: '/img/storage.svg',
					component: SettingsStorage,
				},
				{
					id: 'lishNetwork',
					label: tt('settings.lishNetwork.title'),
					icon: '/img/network.svg',
					component: LISHNetworkList,
				},
				{
					id: 'language',
					label: tt('settings.language'),
					icon: '/img/language.svg',
					submenu: [
						...languages.map(lang => ({
							id: `lang-${lang.id}`,
							label: lang.nativeLabel,
							iconPosition: 'left',
							iconSize: '2vh',
							selected: () => get(currentLanguage) === lang.id,
							onSelect: () => setLanguage(lang.id),
						})),
						{
							id: 'back',
							label: tt('common.back'),
							icon: '/img/back.svg',
							iconPosition: 'left',
							iconSize: '2vh',
							action: 'back' as const,
						},
					],
				},
				{
					id: 'time',
					label: tt('settings.time.label'),
					icon: '/img/time.svg',
					submenu: [
						{
							id: 'time-format',
							label: tt('settings.time.format'),
							icon: '/img/time.svg',
							submenu: [
								{
									id: 'time-format-24',
									label: tt('settings.time.24hour'),
									iconPosition: 'left',
									iconSize: '2vh',
									selected: () => get(timeFormat) === true,
									onSelect: () => setTimeFormat(true),
								},
								{
									id: 'time-format-12',
									label: tt('settings.time.12hour'),
									iconPosition: 'left',
									iconSize: '2vh',
									selected: () => get(timeFormat) === false,
									onSelect: () => setTimeFormat(false),
								},
								{
									id: 'back',
									label: tt('common.back'),
									icon: '/img/back.svg',
									iconPosition: 'left',
									iconSize: '2vh',
									action: 'back' as const,
								},
							],
						},
						{
							id: 'time-seconds',
							label: tt('settings.time.showSeconds'),
							icon: '/img/time.svg',
							submenu: [
								{
									id: 'time-seconds-yes',
									label: tt('common.yes'),
									iconPosition: 'left',
									iconSize: '2vh',
									selected: () => get(showSeconds) === true,
									onSelect: () => setShowSeconds(true),
								},
								{
									id: 'time-seconds-no',
									label: tt('common.no'),
									iconPosition: 'left',
									iconSize: '2vh',
									selected: () => get(showSeconds) === false,
									onSelect: () => setShowSeconds(false),
								},
								{
									id: 'back',
									label: tt('common.back'),
									icon: '/img/back.svg',
									iconPosition: 'left',
									iconSize: '2vh',
									action: 'back' as const,
								},
							],
						},
						{
							id: 'back',
							label: tt('common.back'),
							icon: '/img/back.svg',
							action: 'back' as const,
						},
					],
				},
				{
					id: 'footer',
					label: tt('settings.footer'),
					icon: '/img/footer.svg',
					component: SettingsFooter,
					submenu: [
						{
							id: 'footer-position',
							label: tt('settings.footerPosition'),
							submenu: [
								{
									id: 'footer-pos-left',
									label: tt('settings.footerPositions.left'),
									iconPosition: 'left',
									iconSize: '2vh',
									selected: () => get(footerPosition) === 'left',
									onSelect: () => setFooterPosition('left' as FooterPosition),
								},
								{
									id: 'footer-pos-center',
									label: tt('settings.footerPositions.center'),
									iconPosition: 'left',
									iconSize: '2vh',
									selected: () => get(footerPosition) === 'center',
									onSelect: () => setFooterPosition('center' as FooterPosition),
								},
								{
									id: 'footer-pos-right',
									label: tt('settings.footerPositions.right'),
									iconPosition: 'left',
									iconSize: '2vh',
									selected: () => get(footerPosition) === 'right',
									onSelect: () => setFooterPosition('right' as FooterPosition),
								},
								{
									id: 'back',
									label: tt('common.back'),
									iconPosition: 'left',
									iconSize: '2vh',
									icon: '/img/back.svg',
									action: 'back' as const,
								},
							],
						},
						{
							id: 'back',
							label: tt('common.back'),
							icon: '/img/back.svg',
							action: 'back' as const,
						},
					],
				},
				{
					id: 'audio',
					label: tt('settings.audio'),
					icon: '/img/volume3.svg',
					submenu: [
						{
							id: 'audio-on',
							label: tt('common.yes'),
							iconPosition: 'left',
							iconSize: '2vh',
							selected: () => get(audioEnabled) === true,
							onSelect: () => setAudioEnabled(true),
						},
						{
							id: 'audio-off',
							label: tt('common.no'),
							iconPosition: 'left',
							iconSize: '2vh',
							selected: () => get(audioEnabled) === false,
							onSelect: () => setAudioEnabled(false),
						},
						{
							id: 'back',
							label: tt('common.back'),
							iconPosition: 'left',
							iconSize: '2vh',
							icon: '/img/back.svg',
							action: 'back' as const,
						},
					],
				},
				{
					id: 'cursor',
					label: tt('settings.cursorSize.label'),
					icon: '/img/cursor2.svg',
					submenu: [
						{
							id: 'cursor-small',
							label: tt('settings.cursorSize.sizes.small'),
							iconPosition: 'left',
							iconSize: '2vh',
							selected: () => get(cursorSize) === 'small',
							onSelect: () => setCursorSize('small' as CursorSize),
						},
						{
							id: 'cursor-medium',
							label: tt('settings.cursorSize.sizes.medium'),
							iconPosition: 'left',
							iconSize: '2vh',
							selected: () => get(cursorSize) === 'medium',
							onSelect: () => setCursorSize('medium' as CursorSize),
						},
						{
							id: 'cursor-large',
							label: tt('settings.cursorSize.sizes.large'),
							iconPosition: 'left',
							iconSize: '2vh',
							selected: () => get(cursorSize) === 'large',
							onSelect: () => setCursorSize('large' as CursorSize),
						},
						{
							id: 'back',
							label: tt('common.back'),
							icon: '/img/back.svg',
							iconPosition: 'left',
							iconSize: '2vh',
							action: 'back' as const,
						},
					],
				},
				{
					id: 'back',
					label: tt('common.back'),
					icon: '/img/back.svg',
					action: 'back' as const,
				},
			],
		},
		{
			id: 'about',
			label: tt('about.title'),
			icon: '/img/info.svg',
			component: About,
		},
		{
			id: 'exit',
			label: tt('exit.title'),
			icon: '/img/exit.svg',
			orientation: 'horizontal' as const,
			submenu: [
				{
					id: 'restart',
					icon: '/img/restart.svg',
					label: tt('exit.restart.title'),
					action: 'restart' as const,
				},
				{
					id: 'shutdown',
					icon: '/img/power.svg',
					label: tt('exit.shutdown.title'),
					action: 'shutdown' as const,
				},
				{
					id: 'quit',
					label: tt('exit.quitApplication.title'),
					icon: '/img/exit.svg',
					action: 'quit' as const,
				},
				{
					id: 'back',
					label: tt('common.back'),
					icon: '/img/back.svg',
					action: 'back' as const,
				},
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
