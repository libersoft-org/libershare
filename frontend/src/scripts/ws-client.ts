import { writable } from 'svelte/store';
import { WsClient } from '@libershare/shared';
const defaultApiURL = 'ws://localhost:1158';
export const apiURL = import.meta.env.VITE_BACKEND_URL || defaultApiURL;
console.log('[API] Backend URL:', apiURL);
export const connected = writable(false);

export const wsClient = new WsClient(apiURL, (state: { connected: boolean }) => {
	connected.set(state.connected);
});
