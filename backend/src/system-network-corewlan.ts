// @ts-expect-error Bun embeds this self-contained JavaScript worker as a file asset.
import coreWlanWorkerPath from './system-network-corewlan-worker.js' with { type: 'file' };

/** CWSecurity values from CoreWLANTypes.h, matched to system_profiler labels. */
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

/** Keep synchronous CoreWLAN calls off the backend event loop; credentials stay in process memory. */
export function associateMacWifi(device: string, ssid: string, password: string, security: string): Promise<void> {
	const securityType = macSecurityType(security);
	if (!ssid || Buffer.byteLength(ssid, 'utf8') > 32 || ssid.includes('\0')) throw new Error('macOS cannot identify the requested Wi-Fi network');
	return new Promise((resolve, reject) => {
		const worker = new Worker(coreWlanWorkerPath);
		worker.addEventListener('close', () => reject(new Error('macOS Wi-Fi native worker exited before reporting its result')));
		worker.onmessage = (event: MessageEvent<{ error?: string }>) => {
			if (event.data.error) reject(new Error(event.data.error));
			else resolve();
			worker.terminate();
		};
		worker.onerror = () => {
			reject(new Error('macOS Wi-Fi native worker failed'));
			worker.terminate();
		};
		worker.postMessage({ device, ssid, password, securityType });
	});
}
