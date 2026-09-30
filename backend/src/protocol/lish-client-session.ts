import { LISHClient, LISH_PROTOCOL } from './lish-protocol.ts';
import type { Network } from './network.ts';

/** Keep cancellation attached through the request and stream cleanup. */
export async function withLISHClient<T>(network: Network, peerID: string, signal: AbortSignal, request: (client: LISHClient) => Promise<T>): Promise<T> {
	signal.throwIfAborted();
	const { stream } = await network.dialProtocolByPeerId(peerID, LISH_PROTOCOL, signal);
	let client: LISHClient;
	try {
		client = new LISHClient(stream);
	} catch (error) {
		try {
			stream.abort(error instanceof Error ? error : new Error(String(error)));
		} catch {}
		throw error;
	}
	const onAbort = (): void => client.abort(signal.reason instanceof Error ? signal.reason : new Error('LISH request cancelled'));
	signal.addEventListener('abort', onAbort, { once: true });
	try {
		if (signal.aborted) onAbort();
		signal.throwIfAborted();
		try {
			return await request(client);
		} finally {
			await client.close();
		}
	} finally {
		signal.removeEventListener('abort', onAbort);
	}
}
