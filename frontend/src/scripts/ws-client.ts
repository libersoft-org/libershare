import { get, writable } from 'svelte/store';
import { WsClient, CodedError, ErrorCodes, MAX_API_MESSAGE_SIZE, MAX_UPLOAD_CHUNK_SIZE, formatBytes } from '@shared';
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

/**
 * Bytes per chunk. Shared with the backend, which enforces it: this is the
 * protocol's chunk size, not a local preference.
 */
const UPLOAD_CHUNK_SIZE = MAX_UPLOAD_CHUNK_SIZE;

/**
 * How long one upload step may wait for its acknowledgement. Every step here is
 * a single small round trip against a local-ish backend — a chunk write and a
 * flush — so a minute is generous. It exists because a reply can be lost
 * without this socket ever closing (a proxy losing its backend session, say),
 * and the upload dialog is modal: without a bound it simply never goes away.
 */
const UPLOAD_STEP_TIMEOUT_MS = 60_000;

/**
 * Send a locally picked file to the backend in chunks over the API WebSocket and
 * return the id it is held under. The file is never read into memory whole and
 * never travels as one message — that is what used to take the socket down once
 * an import grew past the frame limit. Each chunk is a binary frame, so the
 * bytes cost their own size rather than a third more as base64, and the next one
 * is only sent once the backend has acknowledged the last, which keeps the send
 * buffer from growing without bound.
 *
 * The id, not a path: the file stays the server's to read and delete, so nothing
 * here can point the generic filesystem methods at it.
 */
export async function uploadImportFile(file: File): Promise<string> {
	// Checked up front so a file that could never be accepted fails immediately
	// instead of after uploading its way to the ceiling.
	if (file.size > MAX_API_MESSAGE_SIZE) throw new CodedError(ErrorCodes.UPLOAD_TOO_LARGE, formatBytes(MAX_API_MESSAGE_SIZE));
	const { uploadID } = await wsClient.call<{ uploadID: string }>('upload.begin', { name: file.name }, UPLOAD_STEP_TIMEOUT_MS);
	try {
		for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_SIZE) {
			const slice = await file.slice(offset, offset + UPLOAD_CHUNK_SIZE).arrayBuffer();
			await wsClient.callBinary('upload.chunk', { uploadID }, new Uint8Array(slice), UPLOAD_STEP_TIMEOUT_MS);
		}
		await wsClient.call('upload.end', { uploadID }, UPLOAD_STEP_TIMEOUT_MS);
		return uploadID;
	} catch (err) {
		// Nothing half-written is left behind. If the socket is what failed, the
		// backend has already dropped the transfer on its own, so a failed abort
		// is not worth reporting over the error that caused it.
		void wsClient.call('upload.abort', { uploadID }).catch(() => {});
		throw err;
	}
}
