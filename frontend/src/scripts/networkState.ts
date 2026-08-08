import { derived, writable, type Readable } from 'svelte/store';
import { api } from './api.ts';
import { deriveConnectionStatus, type ConnectionStatus, type NetworkStateInfo } from '@shared';

/**
 * Host network state as reported by the backend.
 *
 * `known: false` until the first read arrives, so consumers can render an
 * honest "unknown" instead of a placeholder that looks like real data.
 */
export const networkState = writable<NetworkStateInfo>({ interfaces: [], primaryID: null, detail: 'full', known: false });

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
	}
}
