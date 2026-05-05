import { writable } from 'svelte/store';
import { WsClient } from '@shared';
import { addNotification } from './notifications.ts';
import { tt } from './language.ts';
import { getAPIURL } from './api-url.ts';

export const apiURL = getAPIURL();
export const connected = writable(false);

let wasConnected = false;
let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
export const wsClient = new WsClient(apiURL, (state: { connected: boolean }) => {
	connected.set(state.connected);
	if (state.connected) {
		if (disconnectTimer) {
			clearTimeout(disconnectTimer);
			disconnectTimer = undefined;
		}
		if (wasConnected) addNotification(tt('common.reconnected'), 'success');
	} else if (wasConnected) {
		if (!disconnectTimer) {
			disconnectTimer = setTimeout(() => {
				disconnectTimer = undefined;
				addNotification(tt('common.backendDisconnected'), 'warning');
			}, 3000);
		}
	}
	wasConnected = true;
});
wsClient.onError = () => addNotification(tt('common.websocketError'), 'error');
