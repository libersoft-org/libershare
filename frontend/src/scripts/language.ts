import { writable, derived, get } from 'svelte/store';
import { api } from './api.ts';
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
export const currentLanguage = writable<string>('en');
const langCache: Record<string, any> = {}; // Cache for loaded language files
export const translations = writable<any>({}); // Store for current translations

// Helper function to get nested value from object by path
function getNestedValue(obj: any, path: string): string | undefined {
	const result = path.split('.').reduce((current, key) => current?.[key], obj);
	return typeof result === 'string' ? result : undefined;
}

// Reactive translation function - use as $t('common.back') or $t('key', { name: 'foo' }) in components
// Returns the translation value or '{key}' fallback if missing
// When vars are provided, replaces {placeholder} tokens with values
export const t = derived(translations, $translations => {
	return (key: string, vars?: Record<string, string>): string => {
		const text = getNestedValue($translations, key) ?? `{${key}}`;
		return vars ? text.replace(/\{(\w+)\}/g, (match, k) => vars[k] ?? match) : text;
	};
});

// Initialize and update translations when language changes
currentLanguage.subscribe(async langID => {
	const data = await loadLanguage(langID);
	translations.set(data);
});

// Initialize with browser language or default
initLanguage();

function initLanguage(): void {
	const browserLang = navigator.language?.split('-')[0];
	const initialLang = browserLang && languages.some(l => l.id === browserLang) ? browserLang : 'en';
	currentLanguage.set(initialLang);
}

// Load language file
async function loadLanguage(langID: string): Promise<any> {
	if (langCache[langID]) return langCache[langID];
	try {
		const response = await fetch(`/langs/${langID}.json`);
		const data = await response.json();
		langCache[langID] = data;
		return data;
	} catch (error) {
		console.error(`Failed to load language ${langID}:`, error);
		return {};
	}
}

export function setLanguage(languageID: string): void {
	currentLanguage.set(languageID);
	api.settings.set('language', languageID).catch((err: unknown) => console.error('[Language] Error saving:', err));
}

export function getLanguage(id: string): Language | undefined {
	return languages.find(lang => lang.id === id);
}

// Get flag URL for a language
export function getFlagURL(langID: string): string {
	const lang = getLanguage(langID);
	const flagCode = lang?.flag ?? langID;
	return `/flags/${flagCode}.svg`;
}

// Function for translations outside components - use as tt('common.back') or tt('key', { name: 'foo' })
export function tt(key: string, vars?: Record<string, string>): string {
	const current = get(translations);
	const text = getNestedValue(current, key) ?? `{${key}}`;
	return vars ? text.replace(/\{(\w+)\}/g, (match, k) => vars[k] ?? match) : text;
}

// Helper to append optional detail to a message: withDetail("Failed", error) → "Failed: error"
export function withDetail(message: string, detail?: string | null): string {
	return detail ? `${message}: ${detail}` : message;
}

// Maps backend error codes to translation key paths in the language files.
const errorCodeKeys: Record<string, string> = {
	// LISH
	LISH_NOT_FOUND: 'lish.errorNotFound',
	NO_LISHS: 'lish.errorNoLISHs',
	DIRECTORY_EMPTY: 'lish.errorDirectoryEmpty',
	LISH_ALREADY_EXISTS: 'lish.errorAlreadyExists',
	INVALID_INPUT_TYPE: 'lish.errorInvalidInputType',
	LISH_INVALID_FORMAT: 'lish.errorInvalidFormat',
	LISH_MISSING_ID: 'lish.errorMissingID',
	LISH_MISSING_CREATED: 'lish.errorMissingCreated',
	LISH_INVALID_CHUNK_SIZE: 'lish.errorInvalidChunkSize',
	LISH_UNSUPPORTED_CHECKSUM: 'lish.errorUnsupportedChecksum',
	LISH_UNEXPECTED_ARRAY: 'lish.errorUnexpectedArray',
	PATH_ACCESS_DENIED: 'lish.errorPathAccessDenied',
	INVALID_FILE_INDEX: 'lish.errorInvalidFileIndex',
	IO_NOT_FOUND: 'lish.errorIONotFound',
	DOWNLOADER_NOT_INITIALIZED: 'lish.errorDownloaderNotInitialized',
	DOWNLOAD_ERROR: 'lish.errorDownload',
	// Network → settings.lishNetwork
	NETWORK_NOT_FOUND: 'settings.lishNetwork.errorNotFound',
	NO_NETWORKS: 'settings.lishNetwork.errorNoNetworks',
	NETWORK_NOT_JOINED: 'settings.lishNetwork.errorNotJoined',
	NETWORK_NOT_RUNNING: 'settings.lishNetwork.errorNotRunning',
	NETWORK_INVALID: 'settings.lishNetwork.errorInvalid',
	NO_VALID_NETWORKS: 'settings.lishNetwork.errorNoValidNetworks',
	NETWORK_NOT_STARTED: 'settings.lishNetwork.errorNotStarted',
	NETWORK_PORT_IN_USE: 'settings.lishNetwork.errorPortInUse',
	// Server → common
	PARSE_ERROR: 'common.errorParseError',
	METHOD_REQUIRED: 'common.errorMethodRequired',
	UNKNOWN_METHOD: 'common.errorUnknownMethod',
	INTERNAL_ERROR: 'common.errorInternal',
	// Common
	INVALID_JSON: 'common.errorInvalidJSON',
	MISSING_PARAMETER: 'common.errorMissingParameter',
	UNSUPPORTED_COMPRESSION: 'common.errorUnsupportedCompression',
	UNSUPPORTED_DECOMPRESSION: 'common.errorUnsupportedDecompression',
	HTTP_ERROR: 'common.errorHTTP',
	INVALID_SIZE_FORMAT: 'common.errorInvalidSizeFormat',
};

/**
 * Translate a backend error to a localized message.
 * The error object carries `code` (error code string) and optionally `detail`.
 * Looks up the categorized translation key via errorCodeKeys and interpolates {detail}.
 * Falls back to the raw error message if no translation is found.
 */
export function translateError(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const code: string | undefined = (err as any).code;
	const detail: string | undefined = (err as any).detail;
	if (!code) return err.message;
	const current = get(translations);
	const key = errorCodeKeys[code];
	const translated = key ? getNestedValue(current, key) : undefined;
	if (!translated) return detail ? `${code}: ${detail}` : code;
	return detail ? translated.replace(/\{detail\}/g, detail) : translated.replace(/:\s*\{detail\}/, '');
}
