import { type Settings, type SettingsData } from '../settings.ts';
import { applyNetworkLimits } from '../protocol/network-limits.ts';
import { Utils } from '../utils.ts';
import { type CompressionAlgorithm, type SuccessResponse, type ISettingsImportResult, CodedError, ErrorCodes } from '@shared';
const assert = Utils.assertParams;

const ALLOWED_ROOT_KEYS = new Set(['language', 'ui', 'audio', 'storage', 'network', 'system', 'export', 'input']);

function validateBackup(data: unknown): asserts data is Record<string, unknown> {
	if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CodedError(ErrorCodes.INVALID_SETTINGS_BACKUP);
	const obj = data as Record<string, unknown>;
	let hasKnown = false;
	for (const key of Object.keys(obj)) {
		if (ALLOWED_ROOT_KEYS.has(key)) {
			hasKnown = true;
			break;
		}
	}
	if (!hasKnown) throw new CodedError(ErrorCodes.INVALID_SETTINGS_BACKUP);
}

// A single setting flattened to a dotted path and its value.
export interface FlatSetting {
	path: string;
	value: unknown;
}

function flattenSettings(obj: Record<string, unknown>, prefix: string = ''): FlatSetting[] {
	const result: FlatSetting[] = [];
	for (const [key, value] of Object.entries(obj)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (value !== null && typeof value === 'object' && !Array.isArray(value)) result.push(...flattenSettings(value as Record<string, unknown>, path));
		else result.push({ path, value });
	}
	return result;
}

interface SettingsHandlers {
	get: (p: { path: string }) => any;
	set: (p: { path: string; value: any }) => Promise<boolean>;
	list: () => SettingsData;
	getDefaults: () => SettingsData;
	reset: () => Promise<SettingsData>;
	exportToFile: (p: { filePath: string; minifyJSON?: boolean; compress?: boolean; compressionAlgorithm?: CompressionAlgorithm }) => Promise<SuccessResponse>;
	parseFromFile: (p: { filePath: string }) => Promise<Record<string, unknown>>;
	parseFromJSON: (p: { json: string }) => Record<string, unknown>;
	parseFromURL: (p: { url: string }) => Promise<Record<string, unknown>>;
	applyImported: (p: { data: Record<string, unknown> }) => Promise<ISettingsImportResult>;
}

export function initSettingsHandlers(settings: Settings): SettingsHandlers {
	function get(p: { path: string }): any {
		assert(p, ['path']);
		return settings.get(p.path);
	}

	async function set(p: { path: string; value: any }): Promise<boolean> {
		assert(p, ['path', 'value']);
		// Confine writes to known top-level settings groups. This rejects unknown
		// roots and — together with the key guard in JSONStorage.set — blocks
		// prototype-pollution paths such as "__proto__.x" or "constructor.x".
		const rootKey = p.path.split('.')[0];
		if (!rootKey || !ALLOWED_ROOT_KEYS.has(rootKey)) throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, `Unknown settings key: ${p.path}`);
		await settings.set(p.path, p.value);
		// Re-push all runtime limits on any network write (idempotent). Path-by-path
		// matching used to miss whole-object writes such as path === 'network'.
		if (rootKey === 'network') applyNetworkLimits(settings.get().network);
		return true;
	}

	function list(): SettingsData {
		return settings.list();
	}
	function getDefaults(): SettingsData {
		return settings.getDefaults();
	}
	async function reset(): Promise<SettingsData> {
		const data = await settings.reset();
		// Without this the module-level limits keep the pre-reset values.
		applyNetworkLimits(data.network);
		return data;
	}

	async function exportToFile(p: { filePath: string; minifyJSON?: boolean; compress?: boolean; compressionAlgorithm?: CompressionAlgorithm }): Promise<SuccessResponse> {
		assert(p, ['filePath']);
		const resolved = Utils.expandHome(p.filePath);
		const data = settings.list();
		await Utils.writeJSONToFile(data, resolved, p.minifyJSON, p.compress, p.compressionAlgorithm);
		console.log(`✓ Settings exported to: ${resolved}`);
		return { success: true };
	}

	async function parseFromFile(p: { filePath: string }): Promise<Record<string, unknown>> {
		assert(p, ['filePath']);
		const text = await Utils.readFileCompressed(Utils.expandHome(p.filePath));
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			throw new CodedError(ErrorCodes.INVALID_JSON, (err as Error).message);
		}
		validateBackup(parsed);
		return parsed;
	}

	function parseFromJSON(p: { json: string }): Record<string, unknown> {
		assert(p, ['json']);
		let parsed: unknown;
		try {
			parsed = JSON.parse(p.json);
		} catch (err) {
			throw new CodedError(ErrorCodes.INVALID_JSON, (err as Error).message);
		}
		validateBackup(parsed);
		return parsed;
	}

	async function parseFromURL(p: { url: string }): Promise<Record<string, unknown>> {
		assert(p, ['url']);
		const text = await Utils.fetchURL(p.url);
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			throw new CodedError(ErrorCodes.INVALID_JSON, (err as Error).message);
		}
		validateBackup(parsed);
		return parsed;
	}

	async function applyImported(p: { data: Record<string, unknown> }): Promise<ISettingsImportResult> {
		assert(p, ['data']);
		validateBackup(p.data);
		const filtered: Record<string, unknown> = {};
		for (const key of Object.keys(p.data)) {
			if (ALLOWED_ROOT_KEYS.has(key)) filtered[key] = p.data[key];
		}
		const flat = flattenSettings(filtered);
		const skipped: string[] = [];
		let applied = 0;
		for (const entry of flat) {
			try {
				await settings.set(entry.path, entry.value);
				applied++;
			} catch (err) {
				console.warn(`Skipped settings key '${entry.path}':`, (err as Error).message);
				skipped.push(entry.path);
			}
		}
		applyNetworkLimits(settings.get().network);
		console.log(`✓ Settings restored: ${applied} applied, ${skipped.length} skipped`);
		return { applied, skipped };
	}

	return { get, set, list, getDefaults, reset, exportToFile, parseFromFile, parseFromJSON, parseFromURL, applyImported };
}
