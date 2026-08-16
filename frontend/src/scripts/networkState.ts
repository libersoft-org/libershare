import { derived, writable, type Readable } from 'svelte/store';
import { api } from './api.ts';
import { deriveConnectionStatus, type ConnectionStatus, type NetIPv4Config, type NetworkStateInfo, type NetWifiNetwork } from '@shared';

/**
 * Host network state as reported by the backend.
 *
 * `known: false` until the first read arrives, so consumers can render an
 * honest "unknown" instead of a placeholder that looks like real data.
 */
/**
 * What the frontend knows before, and after, it knows anything.
 *
 * No interfaces, no capabilities, `known: false`. Used both as the initial value
 * and as what a failed read falls back to, so "we have not asked yet" and "the
 * answer we had is no longer trustworthy" are represented by the same state
 * rather than by a stale snapshot with a flag turned off.
 */
export function unknownNetworkState(): NetworkStateInfo {
	return { interfaces: [], primaryID: null, detail: 'full', known: false, capabilities: { ipv4: false, wifi: false } };
}

export const networkState = writable<NetworkStateInfo>(unknownNetworkState());

/** The footer connection widget's input, projected from {@link networkState}. */
export const connectionStatus: Readable<ConnectionStatus> = derived(networkState, deriveConnectionStatus);

let handlersRegistered = false;

/** Subscribe to network-state broadcasts and take one immediate snapshot. */
export async function initNetworkState(): Promise<void> {
	if (!handlersRegistered) {
		handlersRegistered = true;
		api.on('system:network', (data: NetworkStateInfo) => {
			networkState.set(data);
		});
	}
	api.subscribe('system:network');
	// The backend only broadcasts every 10 s, so without this the widget would sit
	// on "unknown" for up to that long after every (re)connect.
	try {
		networkState.set(await api.call<NetworkStateInfo>('system.network'));
	} catch (error) {
		console.error('[NetworkState] Error loading network state:', error);
		// The snapshot we still hold predates a backend restart or a failed read, so
		// it may describe a machine state that no longer exists. The whole of it goes,
		// not just the `known` flag: the interface list and the CAPABILITIES were the
		// live parts, and the settings screen gates its Configure buttons on those.
		// Keeping them while flagging the state unknown left buttons active that
		// referred to a host state nobody could still vouch for.
		networkState.set(unknownNetworkState());
	}
}

/**
 * Apply an IPv4 configuration to one interface.
 *
 * The backend answers with the state that resulted, which is stored immediately:
 * the user just changed the interface they are looking at and must see what
 * actually happened rather than wait up to 10 s for the next broadcast.
 */
export async function applyInterfaceConfig(interfaceID: string, config: NetIPv4Config): Promise<void> {
	networkState.set(await api.call<NetworkStateInfo>('system.networkApply', { interfaceID, config }));
}

/**
 * Whether a scanned Wi-Fi row may be acted on right now.
 *
 * `busy` covers an apply or a join already in flight. `scanning` matters just as
 * much and used to be missed: the scan button was disabled during a sweep but
 * the result rows were not, so a user could start a join on the same radio that
 * was mid-scan — and the backend does not serialise the two either, because the
 * scan is outside the apply lock.
 *
 * The network the interface is already ON is not joinable either. Re-selecting
 * it has nothing to gain and a great deal to lose: on Windows a join rewrites
 * the stored profile before it associates, so pressing the row the check mark is
 * already against would replace a working saved network's configuration in order
 * to arrive back where it started.
 */
export function isJoinable(network: NetWifiNetwork, state: { busy: boolean; scanning: boolean }): boolean {
	return !state.busy && !state.scanning && !network.active;
}

/** Scan for Wi-Fi networks reachable from one interface. */
export function scanWifiNetworks(interfaceID: string): Promise<NetWifiNetwork[]> {
	return api.call<NetWifiNetwork[]>('system.wifiScan', { interfaceID });
}

/** Join a Wi-Fi network. An empty password means an open network. */
export async function joinWifiNetwork(interfaceID: string, ssid: string, password: string): Promise<void> {
	networkState.set(await api.call<NetworkStateInfo>('system.wifiConnect', { interfaceID, ssid, password }));
}
