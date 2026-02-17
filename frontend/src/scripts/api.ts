import { writable } from 'svelte/store';
import { wsClient } from './ws-client.ts';
import { Api } from '@shared';
export const api = new Api(wsClient);
// Stores (updated via events from backend)
export const stats = writable<{ [key: string]: any }>({});
// Event handlers
wsClient.on('stats', (data: any) => {
	console.log('[API] Stats update:', data);
	stats.set({ ...data, ts: Date.now() });
});
