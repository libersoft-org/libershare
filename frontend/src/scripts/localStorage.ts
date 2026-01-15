const STORAGE_KEY = 'settings';

function getStorage(): Record<string, any> {
	try {
		const data = localStorage.getItem(STORAGE_KEY);
		return data ? JSON.parse(data) : {};
	} catch (e) {
		console.error('Failed to read from localStorage:', e);
		return {};
	}
}

function saveStorage(settings: Record<string, any>): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch (e) {
		console.error('Failed to write to localStorage:', e);
	}
}

export function getStorageValue<T>(key: string, defaultValue: T): T {
	const settings = getStorage();
	return key in settings ? settings[key] : defaultValue;
}

export function setStorageValue<T>(key: string, value: T): void {
	const settings = getStorage();
	settings[key] = value;
	saveStorage(settings);
}
