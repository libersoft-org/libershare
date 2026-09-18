/**
 * The list of languages the app ships, and nothing else.
 *
 * Separate from `language.ts` because that module reaches the API client, and the client
 * opens a socket and polls `/status` the moment it is imported. Anything that only wants
 * to know which languages exist — the translation-completeness check, for one — would
 * otherwise start a network stack to read a four-line array.
 */
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
