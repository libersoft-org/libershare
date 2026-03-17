import { writable } from 'svelte/store';
import { api } from './api.ts';
import { tt } from './language.ts';
import { addNotification } from './notifications.ts';
// Reactive store of peer counts per network, updated via push events from backend, key: networkID, value: number of connected peers
export const peerCounts = writable<Record<string, number>>({});
let handlersRegistered = false;
let unsubListener: (() => void) | null = null;

// Register global event handlers for LISH network join/leave events. Should be called once during app initialization.
export async function initNetworkEvents(): Promise<void> {
	if (handlersRegistered) return;
	handlersRegistered = true;
	api.on('lishnets:joined', (data: { networkID: string; name: string }) => addNotification(tt('settings.lishNetwork.networkConnected', { name: data.name })));
	api.on('lishnets:left', (data: { networkID: string; name: string }) => addNotification(tt('settings.lishNetwork.networkDisconnected', { name: data.name })));
	await api.subscribe('lishnets:joined');
	await api.subscribe('lishnets:left');
}

// Subscribe to peer count updates from backend. Call when entering the LISH Network settings page.
export async function subscribePeerCounts(): Promise<void> {
	if (unsubListener) return; // already subscribed
	unsubListener = api.on('peers:count', (data: { networkID: string; count: number }[]) => {
		const counts: Record<string, number> = {};
		for (const { networkID, count } of data) counts[networkID] = count;
		peerCounts.set(counts);
	}) as () => void;
	await api.subscribe('peers:count');
}

// Unsubscribe from peer count updates. Call when leaving the LISH Network settings page.
export async function unsubscribePeerCounts(): Promise<void> {
	if (!unsubListener) return;
	await api.unsubscribe('peers:count');
	unsubListener();
	unsubListener = null;
	peerCounts.set({});
}
