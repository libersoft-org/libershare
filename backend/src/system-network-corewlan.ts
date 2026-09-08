// @ts-expect-error Bun embeds this self-contained JavaScript worker as a file asset.
import coreWlanWorkerPath from './system-network-corewlan-worker.js' with { type: 'file' };
import { type NetWifiInfo, type NetWifiNetwork } from '@shared';

export interface MacWifiInterface {
	device: string;
	wifi: NetWifiInfo;
	configurable: boolean;
}

type CoreWlanRequest = { operation: 'state' } | { operation: 'scan'; device: string } | { operation: 'disconnect'; device: string } | { operation: 'associate'; device: string; ssidHex: string; password: string; securityType: number; bssid: string | null };

// Shared worker phase: 0 = preparing/reading, 1 = mutation started, 2 = cancelled.
let pending: { worker: Worker; phase: Int32Array; mutationUnsettled: boolean } | null = null;
const NATIVE_BUSY = 'macOS Wi-Fi native operation is still finishing; try again after it has stopped';

/** A timed-out native Wi-Fi mutation must not overlap even an elevated IPv4 change. */
export function assertMacWifiMutationIdle(): void {
	if (pending && (pending.mutationUnsettled || Atomics.load(pending.phase, 0) === 1)) throw new Error(NATIVE_BUSY);
}

/** CWSecurity values from CoreWLANTypes.h, matched to the scanner labels. */
export function macSecurityType(security: string): number {
	const label = security
		.replace(/\s+Personal$/i, '')
		.replace(/\s+/g, '')
		.toUpperCase();
	const types: Record<string, number> = { '': 0, WPA: 2, 'WPA/WPA2': 3, WPA2: 4, WPA3: 11, 'WPA2/WPA3': 13, 'WPA3/WPA2': 13, WPA3TRANSITION: 13 };
	const type = types[label];
	if (type === undefined) throw new Error('macOS Wi-Fi authentication method is not supported');
	return type;
}

/** Validate raw SSID identity independently of its potentially lossy display name. */
export function macSsidHex(ssid: string, ssidHex: string | null = null): string {
	if (!ssid || ssid.includes('\0') || (ssidHex !== null && !/^(?:[0-9a-f]{2}){1,32}$/i.test(ssidHex))) throw new Error('macOS cannot identify the requested Wi-Fi network');
	const bytes = ssidHex === null ? Buffer.from(ssid, 'utf8') : Buffer.from(ssidHex, 'hex');
	if (bytes.length > 32 || bytes.toString('utf8') !== ssid) throw new Error('macOS cannot identify the requested Wi-Fi network');
	return bytes.toString('hex');
}

/** Keep synchronous native calls off the backend event loop; credentials stay in process memory. */
function runCoreWlan<T>(request: CoreWlanRequest): Promise<T> {
	if (pending) return Promise.reject(new Error(NATIVE_BUSY));
	return new Promise((resolve, reject) => {
		const worker = new Worker(coreWlanWorkerPath);
		const current = { worker, phase: new Int32Array(new SharedArrayBuffer(4)), mutationUnsettled: false };
		pending = current;
		let result: { error?: Error; value?: T } | undefined;
		let expired = false;
		const timer = setTimeout(
			() => {
				expired = true;
				current.mutationUnsettled = Atomics.exchange(current.phase, 0, 2) === 1;
				worker.terminate();
				reject(new Error(current.mutationUnsettled ? `macOS Wi-Fi ${request.operation === 'disconnect' ? 'disconnect' : 'association'} timed out; its result is unknown and further network changes are blocked until the native operation stops` : 'macOS Wi-Fi native operation timed out before any network change was started'));
			},
			request.operation === 'associate' ? 45_000 : 20_000
		);
		worker.addEventListener('close', () => {
			clearTimeout(timer);
			if (pending === current) pending = null;
			if (expired) return;
			if (!result) reject(new Error('macOS Wi-Fi native worker exited before reporting its result'));
			else if (result.error) reject(result.error);
			else resolve(result.value as T);
		});
		worker.onmessage = (event: MessageEvent<{ error?: string; result: T }>) => {
			if (expired) return;
			result = event.data.error ? { error: new Error(event.data.error) } : { value: event.data.result };
			worker.terminate();
		};
		worker.onerror = () => {
			result = { error: new Error('macOS Wi-Fi native worker failed') };
			worker.terminate();
		};
		try {
			worker.postMessage({ ...request, phase: current.phase });
		} catch {
			result = { error: new Error('macOS Wi-Fi native worker could not receive the request') };
			worker.terminate();
		}
	});
}

export function readCoreWlanWifi(): Promise<MacWifiInterface[]> {
	return runCoreWlan({ operation: 'state' });
}

export function scanCoreWlanWifi(device: string): Promise<NetWifiNetwork[]> {
	return runCoreWlan({ operation: 'scan', device });
}

export function associateMacWifi(device: string, ssid: string, password: string, security: string, bssid: string | null = null, ssidHex: string | null = null): Promise<void> {
	const securityType = macSecurityType(security);
	if (securityType === 0 && password) throw new Error('An open Wi-Fi network does not accept a password');
	if (bssid !== null && !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(bssid)) throw new Error('macOS cannot identify the requested access point');
	return runCoreWlan({ operation: 'associate', device, ssidHex: macSsidHex(ssid, ssidHex), password, securityType, bssid: bssid?.toLowerCase() ?? null });
}

export function disconnectCoreWlanWifi(device: string): Promise<void> {
	return runCoreWlan({ operation: 'disconnect', device });
}
