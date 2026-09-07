// @ts-expect-error Bun embeds this self-contained JavaScript worker as a file asset.
import coreWlanWorkerPath from './system-network-corewlan-worker.js' with { type: 'file' };
import { type NetWifiInfo, type NetWifiNetwork } from '@shared';

export interface MacWifiInterface {
	device: string;
	wifi: NetWifiInfo;
	configurable: boolean;
}

type CoreWlanRequest = { operation: 'state' } | { operation: 'scan'; device: string } | { operation: 'associate'; device: string; ssidHex: string; password: string; securityType: number; bssid: string | null };

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
	return new Promise((resolve, reject) => {
		const worker = new Worker(coreWlanWorkerPath);
		worker.addEventListener('close', () => reject(new Error('macOS Wi-Fi native worker exited before reporting its result')));
		worker.onmessage = (event: MessageEvent<{ error?: string; result: T }>) => {
			if (event.data.error) reject(new Error(event.data.error));
			else resolve(event.data.result);
			worker.terminate();
		};
		worker.onerror = () => {
			reject(new Error('macOS Wi-Fi native worker failed'));
			worker.terminate();
		};
		worker.postMessage(request);
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
