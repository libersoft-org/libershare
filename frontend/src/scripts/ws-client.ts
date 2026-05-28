import { get, writable } from 'svelte/store';
import { WsClient } from '@shared';
import { addNotification } from './notifications.ts';
import { tt } from './language.ts';
import { getAPIURL } from './api-url.ts';

export type BackendConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'auth-required' | 'auth-failed';

interface BackendStatusResponse {
	ok: boolean;
	authRequired: boolean;
	authenticated: boolean;
	error?: string;
}

function getInitialBackendToken(): string {
	const envToken = import.meta.env['VITE_LISH_TOKEN'];
	if (typeof envToken === 'string' && envToken) return envToken;
	if (typeof window === 'undefined') return '';
	const injected = (window as any).__BACKEND_TOKEN__;
	return typeof injected === 'string' ? injected : '';
}

function withBackendToken(url: string): string {
	const parsed = new URL(url);
	if (backendToken) parsed.searchParams.set('token', backendToken);
	else parsed.searchParams.delete('token');
	return parsed.toString();
}

function getStatusURL(): string {
	const parsed = new URL(apiURL);
	parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
	parsed.pathname = '/status';
	parsed.search = '';
	if (backendToken) parsed.searchParams.set('token', backendToken);
	return parsed.toString();
}

export const apiURL = getAPIURL();
export const connected = writable(false);
export const backendConnectionStatus = writable<BackendConnectionStatus>('connecting');

let backendToken = getInitialBackendToken();
let authenticatedAPIURL = withBackendToken(apiURL);
let statusCheck: Promise<void> | null = null;

async function checkBackendStatus(): Promise<void> {
	if (statusCheck) return statusCheck;
	statusCheck = (async () => {
		try {
			const response = await fetch(getStatusURL());
			let data: BackendStatusResponse | undefined;
			try {
				data = (await response.json()) as BackendStatusResponse;
			} catch {}
			if (response.status === 401 || (data?.authRequired && !data.authenticated)) {
				wsClient.stopReconnect();
				backendConnectionStatus.set(backendToken ? 'auth-failed' : 'auth-required');
				return;
			}
			if (!response.ok) {
				backendConnectionStatus.set('disconnected');
				return;
			}
			if (!get(connected)) backendConnectionStatus.set('connecting');
		} catch {
			if (!get(connected)) backendConnectionStatus.set('disconnected');
		}
	})().finally(() => {
		statusCheck = null;
	});
	return statusCheck;
}

export function setBackendToken(token: string): void {
	backendToken = token.trim();
	backendConnectionStatus.set('connecting');
	const nextAPIURL = withBackendToken(apiURL);
	void checkBackendStatus();
	wsClient.setAutoReconnect(true);
	if (nextAPIURL === authenticatedAPIURL) wsClient.reconnect();
	else {
		authenticatedAPIURL = nextAPIURL;
		wsClient.setAPIURL(authenticatedAPIURL);
	}
}

let hasConnectedOnce = false;
let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
export const wsClient = new WsClient(authenticatedAPIURL, (state: { connected: boolean }) => {
	connected.set(state.connected);
	if (state.connected) {
		backendConnectionStatus.set('connected');
		if (disconnectTimer) {
			clearTimeout(disconnectTimer);
			disconnectTimer = undefined;
		}
		if (hasConnectedOnce) addNotification(tt('common.reconnected'), 'success');
		hasConnectedOnce = true;
	} else if (hasConnectedOnce) {
		backendConnectionStatus.set('disconnected');
		if (!disconnectTimer) {
			disconnectTimer = setTimeout(() => {
				disconnectTimer = undefined;
				addNotification(tt('common.backendDisconnected'), 'warning');
			}, 3000);
		}
	} else {
		void checkBackendStatus();
	}
});
wsClient.onError = () => {
	if (hasConnectedOnce) addNotification(tt('common.websocketError'), 'error');
	else void checkBackendStatus();
};
void checkBackendStatus();
