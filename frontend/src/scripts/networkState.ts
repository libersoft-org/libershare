import { derived, writable, type Readable } from 'svelte/store';
import { api } from './api.ts';
import { deriveConnectionStatus, type ConnectionStatus, type NetIPv4Config, type NetworkStateInfo, type NetWifiNetwork } from '@shared';

/**
 * Host network state as reported by the backend.
 *
 * `known: false` until the first read arrives, so consumers can render an
 * honest "unknown" instead of a placeholder that looks like real data.
 */
export const networkState = writable<NetworkStateInfo>({ interfaces: [], primaryID: null, detail: 'full', known: false, capabilities: { ipv4: false, wifi: false, staticGatewayRequired: false } });

/** The footer connection widget's input, projected from {@link networkState}. */
export const connectionStatus: Readable<ConnectionStatus> = derived(networkState, deriveConnectionStatus);

let handlersRegistered = false;

/** A rejected subscribe must never become an unhandled promise on startup. */
export async function subscribeNetworkState(subscribe: () => Promise<unknown> = () => api.subscribe('system:network')): Promise<boolean> {
	try {
		await subscribe();
		return true;
	} catch (error) {
		console.error('[NetworkState] Error subscribing to network state:', error);
		return false;
	}
}

/** Subscribe to network-state broadcasts and take one immediate snapshot. */
export async function initNetworkState(): Promise<void> {
	if (!handlersRegistered) {
		handlersRegistered = true;
		api.on('system:network', (data: NetworkStateInfo) => {
			networkState.set(data);
		});
	}
	const subscribed = await subscribeNetworkState();
	// The backend only broadcasts every 10 s, so without this the widget would sit
	// on "unknown" for up to that long after every (re)connect.
	try {
		await refreshNetworkState();
		if (!subscribed) networkState.update(state => ({ ...state, known: false }));
	} catch (error) {
		console.error('[NetworkState] Error loading network state:', error);
		// The snapshot we still hold predates a backend restart or a failed read, so
		// it may describe a machine state that no longer exists. Fall back to
		// "unknown" rather than keep presenting it as current.
		networkState.update(state => ({ ...state, known: false }));
	}
}

/** Fetch and publish the current host state immediately. */
export async function refreshNetworkState(): Promise<NetworkStateInfo> {
	const state = await api.call<NetworkStateInfo>('system.network');
	networkState.set(state);
	return state;
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

/** Scan for Wi-Fi networks reachable from one interface. */
export function scanWifiNetworks(interfaceID: string): Promise<NetWifiNetwork[]> {
	return api.call<NetWifiNetwork[]>('system.wifiScan', { interfaceID });
}

/** Join a Wi-Fi network. An empty password means an open network. */
export async function joinWifiNetwork(interfaceID: string, ssid: string, bssid: string | null, password: string): Promise<NetworkStateInfo> {
	const state = await api.call<NetworkStateInfo>('system.wifiConnect', { interfaceID, ssid, bssid, password });
	networkState.set(state);
	return state;
}
