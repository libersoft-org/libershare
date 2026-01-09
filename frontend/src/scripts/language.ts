import { writable, derived, get } from 'svelte/store';
import { getStorageValue, setStorageValue } from './localStorage.ts';
export interface Language {
	id: string;
	label: string;
	nativeLabel: string;
}
export const languages: Language[] = [
	{ id: 'en', label: 'English', nativeLabel: 'English' },
	{ id: 'cs', label: 'Czech', nativeLabel: 'Čeština' },
];

function getInitialLanguage(): string {
	const saved = getStorageValue<string>('language', 'en');
	return languages.some(l => l.id === saved) ? saved : 'en';
}

export const currentLanguage = writable<string>(getInitialLanguage());
// Cache for loaded language files
const langCache: Record<string, any> = {};
// Store for current translations
export const translations = writable<any>({});
// Load language file
async function loadLanguage(langId: string): Promise<any> {
	if (langCache[langId]) return langCache[langId];
	try {
		const response = await fetch(`/langs/${langId}.json`);
		const data = await response.json();
		langCache[langId] = data;
		return data;
	} catch (error) {
		console.error(`Failed to load language ${langId}:`, error);
		return {};
	}
}
// Initialize and update translations when language changes
currentLanguage.subscribe(async langId => {
	const data = await loadLanguage(langId);
	translations.set(data);
});
// Load initial language
loadLanguage(getInitialLanguage()).then(data => translations.set(data));

export function setLanguage(languageID: string): void {
	setStorageValue('language', languageID);
	currentLanguage.set(languageID);
}

export function getLanguage(id: string): Language | undefined {
	return languages.find(lang => lang.id === id);
}

// Derived store for translations - use as $t.common.back in components
export const t = derived(translations, $translations => $translations);

// Helper function to get nested value from object by path
function getNestedValue(obj: any, path: string): string | undefined {
	const result = path.split('.').reduce((current, key) => current?.[key], obj);
	return typeof result === 'string' ? result : undefined;
}

// Function for translations outside components - use as tt('common.back')
// Reactive when used inside derived stores
export function tt(key: string): string | undefined {
	const current = get(translations);
	return getNestedValue(current, key);
}
