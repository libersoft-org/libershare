import { type Settings, type SettingsData } from '../settings.ts';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;

interface SettingsHandlers {
	get: (p: { path: string }) => any;
	set: (p: { path: string; value: any }) => Promise<boolean>;
	list: () => SettingsData;
	getDefaults: () => SettingsData;
	reset: () => Promise<SettingsData>;
}

export function initSettingsHandlers(settings: Settings): SettingsHandlers {
	function get(p: { path: string }): any {
		assert(p, ['path']);
		return settings.get(p.path);
	}

	async function set(p: { path: string; value: any }): Promise<boolean> {
		assert(p, ['path', 'value']);
		await settings.set(p.path, p.value);
		return true;
	}

	function list(): SettingsData {
		return settings.list();
	}
	function getDefaults(): SettingsData {
		return settings.getDefaults();
	}
	async function reset(): Promise<SettingsData> {
		return settings.reset();
	}

	return { get, set, list, getDefaults, reset };
}
