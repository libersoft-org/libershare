import { type SettingsData } from '../settings.ts';
import { Downloader } from './downloader.ts';
import { setMaxUploadSpeed, setMaxUploadPeersPerLISH, setMaxMessageSize } from './lish-protocol.ts';
import { setMaxDownloadPeersPerLISH } from './peer-manager.ts';

/**
 * Push all runtime network limits from a settings snapshot into the protocol
 * layer's module state. This is the single registration point for these knobs:
 * every writer of `network.*` settings (startup, WS API set/reset/import,
 * factory reset) calls this instead of the individual setters, so a limit can
 * never be applied in one place and silently forgotten in another.
 */
export function applyNetworkLimits(net: SettingsData['network']): void {
	Downloader.setMaxDownloadSpeed(net.maxDownloadSpeed);
	setMaxUploadSpeed(net.maxUploadSpeed);
	setMaxDownloadPeersPerLISH(net.maxDownloadPeersPerLISH);
	setMaxUploadPeersPerLISH(net.maxUploadPeersPerLISH);
	setMaxMessageSize(net.maxMessageSize);
}
