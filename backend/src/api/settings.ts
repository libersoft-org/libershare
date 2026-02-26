import { type Settings, type SettingsData } from '../settings.ts';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;

export function initSettingsHandlers(settings: Settings) {
	function get(p: { path: string }): any {
		assert(p, ['path']);
		return settings.get(p.path);
	}

	async function set(p: { path: string; value: any }): Promise<boolean> {
		assert(p, ['path', 'value']);
		await settings.set(p.path, p.value);
		return true;
	}

	function getAll(): SettingsData {
		return settings.getAll();
	}
	function getDefaults(): SettingsData {
		return settings.getDefaults();
	}
	async function reset(): Promise<SettingsData> {
		return settings.reset();
	}

	return { get, set, getAll, getDefaults, reset };
}
