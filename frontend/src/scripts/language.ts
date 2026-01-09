import { writable } from 'svelte/store';
export interface Language {
	id: string;
	label: string;
	nativeLabel: string;
}
export const languages: Language[] = [
	{ id: 'en', label: 'English', nativeLabel: 'English' },
	{ id: 'cz', label: 'Czech', nativeLabel: 'Čeština' },
];
export const currentLanguage = writable<string>('en');

export function setLanguage(languageID: string): void {
	currentLanguage.set(languageID);
}

export function getLanguage(id: string): Language | undefined {
	return languages.find(lang => lang.id === id);
}
