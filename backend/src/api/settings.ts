import { type Settings } from '../settings.ts';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;

export function initSettingsHandlers(settings: Settings) {
	const get = (p: { path: string }) => {
		assert(p, ['path']);
		return settings.get(p.path);
	};

	const set = async (p: { path: string; value: any }) => {
		assert(p, ['path', 'value']);
		await settings.set(p.path, p.value);
		return true;
	};

	const getAll = () => settings.getAll();
	const getDefaults = () => settings.getDefaults();
	const reset = async () => settings.reset();

	return { get, set, getAll, getDefaults, reset };
}
