import { writable } from 'svelte/store';
import { WsClient, DEFAULT_API_URL } from '@shared';

function getAPIURL(): string {
	// When running inside Tauri, the backend port is passed via initialization script
	if (typeof window !== 'undefined' && (window as any).__BACKEND_PORT__) {
		return `ws://localhost:${(window as any).__BACKEND_PORT__}`;
	}
	return import.meta.env['VITE_BACKEND_URL'] || DEFAULT_API_URL;
}

export const apiURL = getAPIURL();
console.log('[API] Backend URL:', apiURL);
export const connected = writable(false);

export const wsClient = new WsClient(apiURL, (state: { connected: boolean }) => {
	connected.set(state.connected);
});
