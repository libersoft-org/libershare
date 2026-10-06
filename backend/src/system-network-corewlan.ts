declare const LISH_COREWLAN_WORKER_ENTRY: string | undefined;
import { type NetWifiInfo, type NetWifiNetwork } from '@shared';
import { hostApp, type HostAppCall } from './native/host-app.ts';
import { coreWlanInterfaceState, coreWlanNamesVisible, coreWlanScanRows, type CoreWlanNetwork, type CoreWlanSnapshot } from './system-network-corewlan-rows.js';

export interface MacWifiInterface {
	device: string;
	wifi: NetWifiInfo;
	configurable: boolean;
}

type CoreWlanRequest = { operation: 'state' } | { operation: 'scan'; device: string } | { operation: 'disconnect'; device: string } | { operation: 'associate'; device: string; ssidHex: string; password: string; securityType: number; bssid: string | null };

// Shared worker phase: 0 = preparing/reading, 1 = mutation started, 2 = cancelled.
let pending: { worker: Worker | null; phase: Int32Array; mutationUnsettled: boolean } | null = null;
const NATIVE_BUSY = 'macOS Wi-Fi native operation is still finishing; try again after it has stopped';
interface CoreWlanReader {
	readonly worker: Worker;
	readonly closed: Promise<void>;
	closing: boolean;
}
let reader: CoreWlanReader | null = null;

function workerEntry(): string {
	return typeof LISH_COREWLAN_WORKER_ENTRY === 'string' ? new URL(LISH_COREWLAN_WORKER_ENTRY, import.meta.url).href : new URL('./system-network-corewlan-worker.js', import.meta.url).href;
}

function getReader(): CoreWlanReader {
	if (reader?.closing) throw new Error(NATIVE_BUSY);
	if (reader) return reader;
	const worker = new Worker(workerEntry());
	let resolveClosed!: () => void;
	const current: CoreWlanReader = {
		worker,
		closing: false,
		closed: new Promise<void>(resolve => {
			resolveClosed = resolve;
		}),
	};
	reader = current;
	worker.unref();
	worker.addEventListener('message', (event: MessageEvent<{ closed?: boolean }>) => {
		if (current.closing && event.data.closed) worker.terminate();
	});
	worker.addEventListener('close', () => {
		if (reader === current) reader = null;
		resolveClosed();
	});
	return current;
}

function closeReader(current: CoreWlanReader): void {
	if (current.closing) return;
	current.closing = true;
	current.worker.ref();
	try {
		current.worker.postMessage({ operation: 'close' });
	} catch {
		if (pending?.worker !== current.worker) current.worker.terminate();
	}
}

export async function closeCoreWlanReads(): Promise<void> {
	const current = reader;
	if (!current) return;
	closeReader(current);
	await current.closed;
}

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
	const host = hostApp();
	if (host) return runInHostApp(host, request) as Promise<T>;
	return new Promise((resolve, reject) => {
		const reading = request.operation === 'state' || request.operation === 'scan';
		const pooled = reading ? getReader() : null;
		const worker = pooled?.worker ?? new Worker(workerEntry());
		worker.ref();
		const current = { worker, phase: new Int32Array(new SharedArrayBuffer(4)), mutationUnsettled: false };
		pending = current;
		let result: { error?: Error; value?: T } | undefined;
		let expired = false;
		let closing = false;
		const close = (): void => {
			if (pooled) {
				closeReader(pooled);
				return;
			}
			if (closing) return;
			closing = true;
			try {
				worker.postMessage({ operation: 'close' });
			} catch {
				worker.terminate();
			}
		};
		const timer = setTimeout(
			() => {
				expired = true;
				current.mutationUnsettled = Atomics.exchange(current.phase, 0, 2) === 1;
				if (pooled) close();
				else worker.terminate();
				reject(new Error(current.mutationUnsettled ? `macOS Wi-Fi ${request.operation === 'disconnect' ? 'disconnect' : 'association'} timed out; its result is unknown and further network changes are blocked until the native operation stops` : 'macOS Wi-Fi native operation timed out before any network change was started'));
			},
			request.operation === 'associate' ? 45_000 : 20_000
		);
		const finish = (): void => {
			clearTimeout(timer);
			worker.onmessage = null;
			worker.onerror = null;
			worker.removeEventListener('close', onClose);
			if (pending === current) pending = null;
			if (expired) return;
			if (!result) reject(new Error('macOS Wi-Fi native worker exited before reporting its result'));
			else if (result.error) reject(result.error);
			else resolve(result.value as T);
		};
		const onClose = (): void => finish();
		worker.addEventListener('close', onClose);
		worker.onmessage = (event: MessageEvent<{ error?: string; result: T; settled?: boolean; closed?: boolean }>) => {
			if (event.data.closed) {
				if (!pooled) worker.terminate();
				return;
			}
			// The worker publishes settled only after its native scope and sensitive buffers close.
			if (reading && !event.data.settled) return;
			if (expired) {
				close();
				return;
			}
			result = event.data.error ? { error: new Error(event.data.error) } : { value: event.data.result };
			if (pooled && !pooled.closing) {
				worker.unref();
				finish();
			} else close();
		};
		worker.onerror = event => {
			event.preventDefault();
			result = { error: new Error('macOS Wi-Fi native worker failed') };
			close();
		};
		try {
			worker.postMessage({ ...request, phase: current.phase });
		} catch {
			result = { error: new Error('macOS Wi-Fi native worker could not receive the request') };
			// No request was dispatched, so there is no native scope to interrupt.
			if (pooled) pooled.closing = true;
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

type HostAppReply = { error: string } | { result?: unknown };

/** Last proven name access per interface, read through the desktop app. */
const hostNamesVisible = new Map<string, boolean>();

/** The app's raw CoreWLAN answer, shaped by the same rules the in-process worker applies. */
function shapeHostAppResult(request: CoreWlanRequest, result: unknown): unknown {
	if (request.operation === 'state') {
		const interfaces = result as Array<{ snapshot: CoreWlanSnapshot; networks: CoreWlanNetwork[] }>;
		return interfaces
			.filter(item => item.snapshot.device)
			.map(item => {
				const device = item.snapshot.device!;
				const visible = coreWlanNamesVisible(item.snapshot, item.networks, hostNamesVisible.get(device));
				hostNamesVisible.set(device, visible);
				return coreWlanInterfaceState(item.snapshot, visible);
			});
	}
	if (request.operation === 'scan') {
		const { snapshot, networks } = result as { snapshot: CoreWlanSnapshot; networks: CoreWlanNetwork[] };
		if (networks.length && !networks.some(network => network.ssidHex)) throw new Error('macOS did not expose Wi-Fi network names');
		return coreWlanScanRows(networks, snapshot);
	}
	return undefined;
}

/**
 * Run one CoreWLAN request in the desktop app, the process macOS lets see network names.
 *
 * The app cannot be interrupted mid-call, so the slot stays taken until it answers: a request that
 * outlives its deadline is reported as failed, and a change that did is reported as unsettled and
 * keeps blocking further network changes until the app's late answer arrives.
 */
function runInHostApp(host: HostAppCall, request: CoreWlanRequest): Promise<unknown> {
	const mutation = request.operation === 'associate' || request.operation === 'disconnect';
	const current = { worker: null, phase: new Int32Array(new SharedArrayBuffer(4)), mutationUnsettled: false };
	// The app starts the change as soon as it reads the request.
	if (mutation) Atomics.store(current.phase, 0, 1);
	pending = current;
	const answer = host(JSON.stringify(request)).finally(() => {
		if (pending === current) pending = null;
	});
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => {
				current.mutationUnsettled = mutation;
				reject(new Error(mutation ? `macOS Wi-Fi ${request.operation === 'disconnect' ? 'disconnect' : 'association'} timed out; its result is unknown and further network changes are blocked until the native operation stops` : 'macOS Wi-Fi native operation timed out before any network change was started'));
			},
			request.operation === 'associate' ? 45_000 : 20_000
		);
		answer.then(
			text => {
				clearTimeout(timer);
				try {
					const reply = JSON.parse(text) as HostAppReply;
					if ('error' in reply) throw new Error(reply.error);
					resolve(shapeHostAppResult(request, reply.result));
				} catch (error) {
					reject(error instanceof Error ? error : new Error('macOS Wi-Fi app answer was invalid'));
				}
			},
			error => {
				clearTimeout(timer);
				// A lost app after the change was sent leaves its outcome unknown.
				current.mutationUnsettled = mutation;
				reject(error instanceof Error ? error : new Error('The desktop app did not answer'));
			}
		);
	});
}
