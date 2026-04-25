import { type Settings, type SettingsData } from '../settings.ts';
import { Downloader } from '../protocol/downloader.ts';
import { setMaxUploadSpeed, setMaxUploadPeersPerLISH } from '../protocol/lish-protocol.ts';
import { setMaxDownloadPeersPerLISH } from '../protocol/peer-manager.ts';
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

	function applySpeedLimits(): void {
		const net = settings.get().network;
		Downloader.setMaxDownloadSpeed(net.maxDownloadSpeed);
		setMaxUploadSpeed(net.maxUploadSpeed);
	}

	function applyPeerLimits(): void {
		const net = settings.get().network;
		setMaxDownloadPeersPerLISH(net.maxDownloadPeersPerLISH);
		setMaxUploadPeersPerLISH(net.maxUploadPeersPerLISH);
	}

	async function set(p: { path: string; value: any }): Promise<boolean> {
		assert(p, ['path', 'value']);
		await settings.set(p.path, p.value);
		if (p.path.startsWith('network.maxDownloadSpeed') || p.path.startsWith('network.maxUploadSpeed')) applySpeedLimits();
		if (p.path.startsWith('network.maxDownloadPeersPerLISH') || p.path.startsWith('network.maxUploadPeersPerLISH')) applyPeerLimits();
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
