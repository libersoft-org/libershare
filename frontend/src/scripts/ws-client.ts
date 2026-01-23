import { writable } from 'svelte/store';
import type { Writable } from 'node:stream';

const API_URL = `ws://${window.location.hostname}:1158`;

type EventCallback = (data: any) => void;

interface PendingRequest {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
}

interface State {
		connected: boolean;
}

export class WsClient {
    private ws: WebSocket | null = null;
    private requestId = 0;
    private pendingRequests = new Map<string | number, PendingRequest>();
    private eventListeners = new Map<string, Set<EventCallback>>();
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private connected = false;
    private connectPromise: Promise<void> | null = null;

    constructor(private stateStore: Writable) {
        this.connect();
    }

    private connect(): Promise<void> {
        if (this.connectPromise) return this.connectPromise;

        this.connectPromise = new Promise((resolve, reject) => {
            this.ws = new WebSocket(API_URL);

            this.ws.onopen = () => {
                console.log('[API] Connected');
                this.connected = true;
								this.stateStore.update((value) => ({ ...value, connected: true }));
                this.connectPromise = null;
                resolve();
            };

            this.ws.onclose = () => {
                console.log('[API] Disconnected');
                this.connected = false;
								this.stateStore.update((value) => ({ ...value, connected: false }));
                this.connectPromise = null;
                this.ws = null;
                this.scheduleReconnect();
            };

            this.ws.onerror = (err) => {
                console.log('[API] WebSocket error', err);
                if (!this.connected) {
                    this.connectPromise = null;
                    reject(new Error('WebSocket connection failed'));
                }
            };

            this.ws.onmessage = (event) => {
                this.handleMessage(event.data);
            };
        });

        return this.connectPromise;
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch(() => {});
        }, 2000);
    }

    private handleMessage(data: string): void {
        let msg: any;
        try {
            msg = JSON.parse(data);
        } catch {
            console.error('[API] Invalid JSON:', data);
            return;
        }

        // Event message
        if (msg.event) {
            const listeners = this.eventListeners.get(msg.event);
            if (listeners) {
                listeners.forEach(cb => cb(msg.data));
            }
            // Also notify wildcard listeners
            const wildcardListeners = this.eventListeners.get('*');
            if (wildcardListeners) {
                wildcardListeners.forEach(cb => cb({ event: msg.event, data: msg.data }));
            }
            return;
        }

        // Response message
        if (msg.id !== undefined) {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
                this.pendingRequests.delete(msg.id);
                if (msg.error) {
                    pending.reject(new Error(msg.error));
                } else {
                    pending.resolve(msg.result);
                }
            }
        }
    }

    private async ensureConnected(): Promise<void> {
        if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
            return;
        }
        await this.connect();
    }

    async call<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
        await this.ensureConnected();

        const id = ++this.requestId;
        const request = { id, method, params };

        return new Promise<T>((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            this.ws!.send(JSON.stringify(request));
        });
    }

    on(event: string, callback: EventCallback): () => void {
        let listeners = this.eventListeners.get(event);
        if (!listeners) {
            listeners = new Set();
            this.eventListeners.set(event, listeners);
        }
        listeners.add(callback);

        return () => {
            listeners!.delete(callback);
            if (listeners!.size === 0) {
                this.eventListeners.delete(event);
            }
        };
    }

    off(event: string, callback: EventCallback): void {
        const listeners = this.eventListeners.get(event);
        if (listeners) {
            listeners.delete(callback);
            if (listeners.size === 0) {
                this.eventListeners.delete(event);
            }
        }
    }
}

export const wsClientState = writable<{ connected: boolean }>({ connected: false });
export const wsClient = new WsClient(wsClientState);
