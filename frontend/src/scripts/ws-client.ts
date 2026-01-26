import { writable, type Writable } from 'svelte/store';
import { WsClient } from '@libershare/shared';

const DEFAULT_API_URL = 'ws://localhost:1158';
const API_URL = import.meta.env.VITE_BACKEND_URL || DEFAULT_API_URL;
console.log('[API] Backend URL:', API_URL);

export const wsClientState = writable<{ connected: boolean }>({ connected: false });
export const wsClient = new WsClient(API_URL, wsClientState.set);
