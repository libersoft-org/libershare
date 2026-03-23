import { writable } from 'svelte/store';
import { WsClient, DEFAULT_API_URL } from '@shared';
import { addNotification } from './notifications.ts';
import { tt } from './language.ts';

function getAPIURL(): string {
	if (typeof window !== 'undefined') {
		// URL param override for multi-node dev testing (e.g. ?backend=ws://localhost:1159)
		if (import.meta.env.DEV) {
			const param = new URLSearchParams(window.location.search).get('backend');
			if (param) return param;
		}
		// When running inside Tauri, the backend port is passed via initialization script
		if ((window as any).__BACKEND_PORT__) return `ws://localhost:${(window as any).__BACKEND_PORT__}`;
	}
	return import.meta.env['VITE_BACKEND_URL'] || DEFAULT_API_URL;
}

export const apiURL = getAPIURL();
export const connected = writable(false);

export const wsClient = new WsClient(apiURL, (state: { connected: boolean }) => {
	connected.set(state.connected);
});
wsClient.onError = () => addNotification(tt('common.websocketError'));
