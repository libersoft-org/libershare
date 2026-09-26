/**
 * The login flow of the real `ws-client.ts`, driven with a controlled `fetch` and WebSocket.
 *
 * A status answer belongs to the login attempt that asked for it. A 401 for an old token that
 * arrives after the user has entered a new one must not stop the new socket or show the form
 * again, and the close that follows a refused token must keep the form on screen.
 */
import { afterAll, expect, test } from 'bun:test';
import { get } from 'svelte/store';

class FakeSocket {
	static instances: FakeSocket[] = [];
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readyState = FakeSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	constructor(readonly url: string) {
		FakeSocket.instances.push(this);
	}
	open(): void {
		this.readyState = FakeSocket.OPEN;
		this.onopen?.();
	}
	close(): void {
		if (this.readyState === FakeSocket.CLOSED) return;
		this.readyState = FakeSocket.CLOSED;
		this.onclose?.();
	}
	send(): void {}
}

interface HeldStatus {
	url: string;
	signal: AbortSignal | undefined;
	answer: (status: number) => void;
}

const held: HeldStatus[] = [];
/** Off for a request whose response had already arrived when its attempt was cancelled. */
let honourAbort = true;
const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;
globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
globalThis.fetch = ((url: string, init?: RequestInit) =>
	new Promise<Response>((resolve, reject) => {
		if (honourAbort) init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
		held.push({ url: String(url), signal: init?.signal ?? undefined, answer: status => resolve(Response.json({ ok: status === 200, authRequired: true, authenticated: status === 200 }, { status })) });
	})) as typeof fetch;

afterAll(() => {
	globalThis.fetch = realFetch;
	globalThis.WebSocket = realWebSocket;
});

// A separate module instance, so other test files that load ws-client keep theirs.
const instance = '../../src/scripts/ws-client.ts?auth-flow';
const client: typeof import('../../src/scripts/ws-client.ts') = await import(instance);

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
const lastSocket = (): FakeSocket => FakeSocket.instances.at(-1)!;
/** The socket WsClient dials for `wanted`; a replaced socket is redialled after its 2 s backoff. */
async function socketFor(wanted: string): Promise<FakeSocket> {
	for (let i = 0; i < 60; i++) {
		const socket = lastSocket();
		if (token(socket.url) === wanted && socket.readyState === FakeSocket.CONNECTING) return socket;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error(`no socket for ${wanted}`);
}
const token = (url: string): string | null => new URL(url).searchParams.get('token');
const status = (): string => get(client.backendConnectionStatus);

test('a stale 401 for the old token does not disturb the new session', async () => {
	// Start: no token, the socket fails, status answers 401 → the form asks for a token.
	held.at(-1)!.answer(401);
	await settle();
	expect(status()).toBe('auth-required');

	// The user enters A; its status request is still in flight when A turns out wrong. Its
	// response is already on its way, so cancelling the attempt does not stop it arriving.
	honourAbort = false;
	client.setBackendToken('token-a');
	const statusA = held.at(-1)!;
	honourAbort = true;
	expect(token(statusA.url)).toBe('token-a');

	// The user enters B before A's status answers. B's socket opens.
	client.setBackendToken('token-b');
	const socketB = await socketFor('token-b');
	socketB.open();
	expect(status()).toBe('connected');

	// A's 401 is delivered late, after B took over: it must change nothing.
	expect(statusA.signal?.aborted).toBe(true);
	statusA.answer(401);
	await settle();
	expect(status()).toBe('connected');
	expect(socketB.readyState).toBe(FakeSocket.OPEN);
});

test('a disconnect after a working session checks the token again and shows the form', async () => {
	// The backend restarts with a different token: the open socket drops.
	const before = held.length;
	lastSocket().close();
	expect(held.length).toBe(before + 1);
	held.at(-1)!.answer(401);
	await settle();
	expect(status()).toBe('auth-failed');

	// The close that stopped reconnecting keeps the form and does not ask again.
	const count = held.length;
	await settle();
	expect(held.length).toBe(count);
	expect(status()).toBe('auth-failed');
});

test('an open that cancels a status check, then a proxy close, gets a fresh check', async () => {
	// Re-entering the same token is a new attempt.
	client.setBackendToken('token-b');
	const pending = held.at(-1)!;
	const socket = await socketFor('token-b');
	socket.open();
	expect(pending.signal?.aborted).toBe(true);

	// The proxy closes with 1011 before the aborted request has run its finally.
	socket.close();
	const fresh = held.at(-1)!;
	expect(fresh).not.toBe(pending);
	fresh.answer(401);
	await settle();
	expect(status()).toBe('auth-failed');

	// Submitting another token connects without reloading.
	client.setBackendToken('token-c');
	(await socketFor('token-c')).open();
	expect(status()).toBe('connected');
});

test('an unreachable backend is not a wrong token', async () => {
	lastSocket().close();
	held.at(-1)!.answer(503);
	await settle();
	expect(status()).toBe('disconnected');
});
