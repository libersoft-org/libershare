import { writable } from 'svelte/store';
import { api } from './api.ts';
import type { RelayStats } from '@shared';

export const relayStats = writable<RelayStats>({ reservations: 0, activeTunnels: 0, downloadSpeed: 0, uploadSpeed: 0 });

let handlersRegistered = false;

export async function initRelayStats(): Promise<void> {
	if (!handlersRegistered) {
		handlersRegistered = true;
		api.on('relay:stats', (data: RelayStats) => {
			relayStats.set(data);
		});
	}
	api.subscribe('relay:stats');
	try {
		relayStats.set(await api.call<RelayStats>('relay.stats'));
	} catch {}
}
