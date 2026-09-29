import { describe, expect, it } from 'bun:test';
import { encode as lpEncode } from 'it-length-prefixed';
import { ErrorCodes } from '@shared';
import { encode as codecEncode } from '../../../src/protocol/codec.ts';
import { initLISHnetsHandlers } from '../../../src/api/lishnets.ts';

/** A peer stream that answers nothing until it is aborted. */
function silentStream(): { stream: any; sent: () => number; aborted: () => boolean } {
	let sent = 0;
	let aborted = false;
	let wake!: () => void;
	const woken = new Promise<void>(r => (wake = r));
	const stream = {
		id: 'silent',
		status: 'open',
		send(): boolean {
			sent++;
			return true;
		},
		async close(): Promise<void> {},
		abort(): void {
			aborted = true;
			stream.status = 'aborted';
			wake();
		},
		async *[Symbol.asyncIterator]() {
			await woken;
			throw new Error('stream aborted');
		},
	};
	return { stream, sent: () => sent, aborted: () => aborted };
}

function handlersOver(network: any, shutdown: AbortController) {
	return initLISHnetsHandlers(
		{ getRunningNetwork: () => network } as never,
		{} as never,
		() => {},
		{} as never,
		async () => ({ lishID: 'unused' }) as never,
		async op => op(),
		shutdown.signal
	);
}

/** Settles within `ms`, or reports that it did not. */
function within<T>(promise: Promise<T>, ms: number): Promise<'settled' | 'pending'> {
	return Promise.race([
		promise.then(
			() => 'settled' as const,
			() => 'settled' as const
		),
		Bun.sleep(ms).then(() => 'pending' as const),
	]);
}

describe('a shutdown cancels the outgoing peer reads the API started', () => {
	it('getPeerLish waiting for a manifest the peer never sends is aborted, stream torn down', async () => {
		const shutdown = new AbortController();
		const peer = silentStream();
		let dialed!: () => void;
		const dialDone = new Promise<void>(r => (dialed = r));
		const network = { dialProtocolByPeerId: async () => (dialed(), { stream: peer.stream, connectionType: 'DIRECT' }) };
		const reading = handlersOver(network, shutdown).getPeerLish({ lishID: 'L', peerID: 'P', networkID: 'N' });
		await dialDone;
		await Bun.sleep(10);
		shutdown.abort(new Error('Backend is shutting down'));
		expect(await within(reading, 1000)).toBe('settled');
		await expect(reading).rejects.toThrow('Backend is shutting down');
		expect(peer.aborted()).toBe(true);
	});

	it('a dial still in progress receives the shutdown signal and ends with it', async () => {
		const shutdown = new AbortController();
		let received: AbortSignal | undefined;
		const network = {
			dialProtocolByPeerId: (_peer: string, _proto: string, signal?: AbortSignal) =>
				new Promise((_, reject) => {
					received = signal;
					signal?.addEventListener('abort', () => reject(signal.reason));
				}),
		};
		const reading = handlersOver(network, shutdown).addPeerLish({ lishID: 'L', peerID: 'P', networkID: 'N' });
		await Bun.sleep(10);
		expect(received).toBe(shutdown.signal);
		shutdown.abort(new Error('Backend is shutting down'));
		expect(await within(reading, 1000)).toBe('settled');
		await expect(reading).rejects.toThrow('Backend is shutting down');
	});

	it('a stream handed back after the abort is torn down without sending the request', async () => {
		const shutdown = new AbortController();
		const peer = silentStream();
		const network = {
			dialProtocolByPeerId: async () => {
				shutdown.abort(new Error('Backend is shutting down'));
				return { stream: peer.stream, connectionType: 'DIRECT' };
			},
		};
		await expect(handlersOver(network, shutdown).getPeerLish({ lishID: 'L', peerID: 'P', networkID: 'N' })).rejects.toThrow('Backend is shutting down');
		expect(peer.sent()).toBe(0);
		expect(peer.aborted()).toBe(true);
	});

	it('the listing retry does not dial again once the shutdown began', async () => {
		const shutdown = new AbortController();
		let dials = 0;
		const network = {
			dialProtocolByPeerId: async () => {
				dials++;
				return {
					stream: {
						id: 'refuse',
						status: 'open',
						send: () => true,
						async close(): Promise<void> {},
						abort(): void {},
						async *[Symbol.asyncIterator]() {
							yield lpEncode.single(codecEncode({ type: 'getLishs-result', error: ErrorCodes.PEER_LISTING_NOT_AUTHORIZED }));
						},
					},
					connectionType: 'DIRECT',
				};
			},
		};
		const listing = handlersOver(network, shutdown).getPeerLishs({ peerID: 'P', networkID: 'N' });
		await Bun.sleep(50);
		shutdown.abort(new Error('Backend is shutting down'));
		await expect(listing).rejects.toThrow('Backend is shutting down');
		expect(dials).toBe(1);
	});
});
