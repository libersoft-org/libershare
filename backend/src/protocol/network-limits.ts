import { type SettingsData, minMessageSizeFor } from '../settings.ts';
import { Downloader } from './downloader.ts';
import { setMaxUploadSpeed, setMaxUploadPeersPerLISH, setMaxMessageSize, setMaxChunkSize } from './lish-protocol.ts';
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
	// A message limit at or below the chunk limit would reject every chunk on arrival, so
	// the chunk limit wins and the message limit is lifted over it. Enforced here rather
	// than at each writer: startup, WS API set/reset/import and factory reset all pass
	// through this function, so no path can install an unusable pair.
	setMaxMessageSize(Math.max(net.maxMessageSize, minMessageSizeFor(net.maxChunkSize)));
	setMaxChunkSize(net.maxChunkSize);
}
