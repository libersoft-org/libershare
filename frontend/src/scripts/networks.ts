import { writable } from 'svelte/store';
import { api } from './api.ts';

/**
 * Reactive store of peer counts per network, updated via push events from backend.
 * Key: networkID, Value: number of connected peers
 */
export const peerCounts = writable<Record<string, number>>({});

let unsubListener: (() => void) | null = null;

/**
 * Subscribe to peer count updates from backend.
 * Call when entering the LISH Network settings page.
 */
export async function subscribePeerCounts(): Promise<void> {
	if (unsubListener) return; // already subscribed
	unsubListener = api.on('peers:count', (data: { networkID: string; count: number }[]) => {
		const counts: Record<string, number> = {};
		for (const { networkID, count } of data) {
			counts[networkID] = count;
		}
		peerCounts.set(counts);
	}) as () => void;
	await api.subscribe('peers:count');
}

/**
 * Unsubscribe from peer count updates.
 * Call when leaving the LISH Network settings page.
 */
export async function unsubscribePeerCounts(): Promise<void> {
	if (!unsubListener) return;
	await api.unsubscribe('peers:count');
	unsubListener();
	unsubListener = null;
	peerCounts.set({});
}
