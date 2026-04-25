import { writable, derived, type Readable } from 'svelte/store';
import { api } from './api.ts';
import { connected } from './ws-client.ts';
import { tt } from './language.ts';
import { addNotification } from './notifications.ts';
// Reactive store of peer counts per network, updated via push events from backend, key: networkID, value: number of connected peers
export const peerCounts = writable<Record<string, number>>({});

// Aggregate summary derived from peerCounts (used by Footer LISH widget).
export interface NetworkSummary {
	connectedNetworks: number; // networks with at least one peer
	totalNetworks: number; // networks currently joined
	totalPeers: number; // sum of peers across all joined networks
}
export const networkSummary: Readable<NetworkSummary> = derived(peerCounts, $counts => {
	const values = Object.values($counts);
	const totalNetworks = values.length;
	let connectedNetworks = 0;
	let totalPeers = 0;
	for (const n of values) {
		totalPeers += n;
		if (n > 0) connectedNetworks++;
	}
	return { connectedNetworks, totalNetworks, totalPeers };
});

let handlersRegistered = false;
let unsubListener: (() => void) | null = null;
let unsubReconnect: (() => void) | null = null;
let subscriberCount = 0;

// Register global event handlers for LISH network join/leave events. Should be called once during app initialization.
export async function initNetworkEvents(): Promise<void> {
	if (!handlersRegistered) {
		handlersRegistered = true;
		api.on('lishnets:joined', (data: { networkID: string; name: string }) => addNotification(tt('settings.lishNetwork.networkConnected', { name: data.name }), 'success'));
		api.on('lishnets:left', (data: { networkID: string; name: string }) => addNotification(tt('settings.lishNetwork.networkDisconnected', { name: data.name }), 'warning'));
		api.on('internet:status', (data: { online: boolean }) => {
			if (data.online) addNotification(tt('common.internetOnline'), 'success');
			else addNotification(tt('common.internetOffline'), 'error');
		});
	}
	// Subscribe on every connect (backend has fresh subscribedEvents after reconnect)
	api.subscribe('lishnets:joined');
	api.subscribe('lishnets:left');
	api.subscribe('internet:status');
}

// Subscribe to peer count updates from backend. Reference-counted so multiple callers (Footer widget + Settings page) can coexist.
export async function subscribePeerCounts(): Promise<void> {
	subscriberCount++;
	if (unsubListener) return; // already subscribed
	unsubListener = api.on('peers:count', (data: { networkID: string; count: number }[]) => {
		const counts: Record<string, number> = {};
		for (const { networkID, count } of data) counts[networkID] = count;
		peerCounts.set(counts);
	}) as () => void;
	api.subscribe('peers:count');
	// Re-subscribe on reconnect (backend has fresh subscribedEvents after reconnect)
	let skipFirst = true;
	unsubReconnect = connected.subscribe(isConnected => {
		if (skipFirst) {
			skipFirst = false;
			return;
		}
		if (isConnected && unsubListener) api.subscribe('peers:count');
	}) as () => void;
}

// Unsubscribe from peer count updates. Reference-counted: actual unsubscribe happens only when the last subscriber leaves.
export async function unsubscribePeerCounts(): Promise<void> {
	if (subscriberCount === 0) return;
	subscriberCount--;
	if (subscriberCount > 0) return;
	if (unsubReconnect) {
		unsubReconnect();
		unsubReconnect = null;
	}
	if (!unsubListener) return;
	await api.unsubscribe('peers:count');
	unsubListener();
	unsubListener = null;
	peerCounts.set({});
}
