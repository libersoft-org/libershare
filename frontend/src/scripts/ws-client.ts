import { writable } from 'svelte/store';
import { WsClient } from '@libershare/shared';

function getApiURL(): string {
	// When running inside Tauri, the backend port is passed via URL query parameter
	if (typeof window !== 'undefined') {
		const params = new URLSearchParams(window.location.search);
		const backendPort = params.get('backendPort');
		if (backendPort) {
			return `ws://localhost:${backendPort}`;
		}
	}
	const defaultApiURL = 'ws://localhost:1158';
	return import.meta.env.VITE_BACKEND_URL || defaultApiURL;
}

export const apiURL = getApiURL();
console.log('[API] Backend URL:', apiURL);
export const connected = writable(false);

export const wsClient = new WsClient(apiURL, (state: { connected: boolean }) => {
	connected.set(state.connected);
});
