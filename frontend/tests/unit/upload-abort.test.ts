/**
 * The frontend's side of discarding an upload.
 *
 * `upload.abort` is a barrier on the server — it waits for whatever operation it
 * interrupted and then for the file to leave the disk before it answers — and
 * the import form blocks a modal dialog on it before starting the next
 * transfer. A reply lost on a socket that stays open therefore has to be bounded
 * here, or that dialog never goes away.
 */
import { test, expect } from 'bun:test';
import { API, CodedError, ErrorCodes, WsClient } from '@shared';

/** Records what the API layer asked the socket to do, and never answers. */
function silentClient(): { client: any; calls: { method: string; timeoutMs?: number | undefined }[] } {
	const calls: { method: string; timeoutMs?: number | undefined }[] = [];
	return {
		calls,
		client: {
			call: (method: string, _params?: Record<string, any>, timeoutMs?: number) => {
				calls.push({ method, timeoutMs });
				return new Promise(() => {});
			},
			on: () => () => {},
			off: () => {},
		},
	};
}

test('abort goes out with a bound on how long it may wait', () => {
	const { client, calls } = silentClient();
	void new API(client).upload.abort('9f1f0b1c-1d1e-4a2b-8c3d-4e5f60718293');
	expect(calls).toHaveLength(1);
	expect(calls[0]!.method).toBe('upload.abort');
	expect(calls[0]!.timeoutMs).toBeGreaterThan(0);
});

test('a lost abort reply ends the wait instead of blocking forever', async () => {
	// A server that reads the request and simply never answers — a proxy that
	// lost its backend session, a handler still stuck on a cleanup. The socket
	// stays open throughout, so nothing else would ever settle this call.
	const server = Bun.serve({
		port: 0,
		fetch: (req, s) => (s.upgrade(req) ? undefined : new Response('expected websocket', { status: 400 })),
		websocket: { message: (): void => {} },
	});
	const client = new WsClient(`ws://localhost:${server.port}`, () => {});
	try {
		const started = Date.now();
		const thrown = await new API(client).upload
			.abort('9f1f0b1c-1d1e-4a2b-8c3d-4e5f60718293', 200)
			.then(() => null)
			.catch((err: CodedError) => err);
		expect(thrown?.code).toBe(ErrorCodes.REQUEST_TIMEOUT);
		expect(Date.now() - started).toBeLessThan(2000);
	} finally {
		client.stopReconnect();
		server.stop(true);
	}
});
