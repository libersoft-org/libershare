import { type Settings } from '../settings.ts';

export function initSettingsHandlers(settings: Settings) {
	const get = (p: { path: string }) => settings.get(p.path);

	const set = async (p: { path: string; value: any }) => {
		await settings.set(p.path, p.value);
		return true;
	};

	const getAll = () => settings.getAll();
	const getDefaults = () => settings.getDefaults();
	const reset = async () => settings.reset();

	return { get, set, getAll, getDefaults, reset };
}
