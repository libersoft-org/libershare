import { type Settings } from '../settings.ts';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;

export function initSettingsHandlers(settings: Settings) {
	function get(p: { path: string }) {
		assert(p, ['path']);
		return settings.get(p.path);
	}

	async function set(p: { path: string; value: any }) {
		assert(p, ['path', 'value']);
		await settings.set(p.path, p.value);
		return true;
	}

	function getAll() { return settings.getAll(); }
	function getDefaults() { return settings.getDefaults(); }
	async function reset() { return settings.reset(); }

	return { get, set, getAll, getDefaults, reset };
}
