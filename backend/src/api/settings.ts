import { type Settings } from '../settings.ts';

type P = Record<string, any>;

export function initSettingsHandlers(settings: Settings) {
	const get = (p: P) => settings.get(p.path);

	const set = (p: P) => {
		settings.set(p.path, p.value);
		return true;
	};

	const getAll = () => settings.getAll();
	const getDefaults = () => settings.getDefaults();
	const reset = () => settings.reset();

	return { get, set, getAll, getDefaults, reset };
}
