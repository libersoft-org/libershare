import { writable, derived, get } from 'svelte/store';
import { getStorageValue, setStorageValue } from './localStorage.ts';
export interface Language {
	id: string;
	label: string;
	nativeLabel: string;
	flag: string; // ISO 3166-1 alpha-2 country code for flag
}
export const languages: Language[] = [
	{ id: 'en', label: 'English', nativeLabel: 'English', flag: 'gb' },
	{ id: 'cs', label: 'Czech', nativeLabel: 'Čeština', flag: 'cz' },
];
export const currentLanguage = writable<string>(getInitialLanguage());
const langCache: Record<string, any> = {}; // Cache for loaded language files
export const translations = writable<any>({}); // Store for current translations

// Helper function to get nested value from object by path
function getNestedValue(obj: any, path: string): string | undefined {
	const result = path.split('.').reduce((current, key) => current?.[key], obj);
	return typeof result === 'string' ? result : undefined;
}

// Reactive translation function - use as $t('common.back') in components
// Returns the translation value or '{key}' fallback if missing
export const t = derived(translations, $translations => {
	return (key: string): string => {
		return getNestedValue($translations, key) ?? `{${key}}`;
	};
});

// Initialize and update translations when language changes
currentLanguage.subscribe(async langId => {
	const data = await loadLanguage(langId);
	translations.set(data);
});
loadLanguage(getInitialLanguage()).then(data => translations.set(data)); // Load initial language

function getInitialLanguage(): string {
	const saved = getStorageValue<string | null>('language', null); // First check localStorage
	if (saved && languages.some(l => l.id === saved)) return saved;
	const browserLang = navigator.language?.split('-')[0]; // Auto-detect from browser + 'en-US' -> 'en'
	if (browserLang && languages.some(l => l.id === browserLang)) return browserLang;
	return 'en'; // Default fallback
}

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

export function setLanguage(languageID: string): void {
	setStorageValue('language', languageID);
	currentLanguage.set(languageID);
}

export function getLanguage(id: string): Language | undefined {
	return languages.find(lang => lang.id === id);
}

// Get flag URL for a language
export function getFlagUrl(langId: string): string {
	const lang = getLanguage(langId);
	const flagCode = lang?.flag ?? langId;
	return `/node_modules/country-flags/svg/${flagCode}.svg`;
}

// Function for translations outside components - use as tt('common.back')
export function tt(key: string): string {
	const current = get(translations);
	return getNestedValue(current, key) ?? `{${key}}`;
}

// Helper to append optional detail to a message: withDetail("Failed", error) → "Failed: error"
export function withDetail(message: string, detail?: string | null): string {
	return detail ? `${message}: ${detail}` : message;
}
