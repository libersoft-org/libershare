import { type SettingsData } from '../settings.ts';
import { Downloader } from './downloader.ts';
import { setMaxUploadSpeed } from './lish-protocol.ts';

/**
 * Push the two transfer rates into the protocol layer's token buckets.
 *
 * Only the rates are pushed. Every other `network.*` limit (peer caps, message
 * size) is read straight from settings at each use — see `networkSetting()` —
 * so it cannot go stale. A rate is different: the bucket carries a throttle
 * cursor that has to be reset the moment the rate changes, which a plain read
 * cannot express. `SpeedLimiter.setLimit()` no-ops on an unchanged value, so
 * re-pushing on every `network.*` write is safe.
 */
export function applyNetworkLimits(net: SettingsData['network']): void {
	Downloader.setMaxDownloadSpeed(net.maxDownloadSpeed);
	setMaxUploadSpeed(net.maxUploadSpeed);
}
