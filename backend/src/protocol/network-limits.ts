import { type Settings, type SettingsData } from '../settings.ts';
import { StorageWriteError } from '../storage.ts';
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

/**
 * Run a settings write and then push the live rates into the protocol layer — also when the
 * write failed to reach the disk. The in-memory settings already carry the change even then,
 * and a transfer throttled by the old rate would contradict the very screen that shows the
 * new one. The rates are read from the live settings at the moment they are applied, never
 * from a snapshot taken before the write, because the lock may meanwhile have let a newer
 * writer publish. The original persistence error is rethrown unchanged; a failure to apply
 * the rates on that path is only logged so it cannot replace it.
 */
export async function persistAndApplyNetworkLimits<R>(settings: Pick<Settings, 'get'>, persist: () => Promise<R>): Promise<R> {
	let result: R;
	try {
		result = await persist();
	} catch (error) {
		if (!(error instanceof StorageWriteError)) throw error;
		try {
			applyNetworkLimits(settings.get().network);
		} catch (applyError) {
			console.error('[Settings] Could not apply transfer limits after a failed save:', (applyError as Error).message);
		}
		throw error;
	}
	applyNetworkLimits(settings.get().network);
	return result;
}
