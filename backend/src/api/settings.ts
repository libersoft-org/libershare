import { type Settings } from '../settings.ts';

type P = Record<string, any>;

export function initSettingsHandlers(settings: Settings) {
	const get = (p: P) => settings.get(p.path);

	const set = async (p: P) => {
		await settings.set(p.path, p.value);
		return true;
	};

	const getAll = () => settings.getAll();
	const getDefaults = () => settings.getDefaults();
	const reset = async () => settings.reset();

	return { get, set, getAll, getDefaults, reset };
}
