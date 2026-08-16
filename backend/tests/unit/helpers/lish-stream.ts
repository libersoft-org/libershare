import { Uint8ArrayList } from 'uint8arraylist';
import { decode as lpDecode, encode as lpEncode } from 'it-length-prefixed';
import { encode as codecEncode, decode as codecDecode } from '../../../src/protocol/codec.ts';

/**
 * Stream stand-ins for driving the real LISH protocol handler in a unit test.
 *
 * The handler wraps whatever it is given in a length-prefixed decoder and writes framed
 * responses back through `send`, so a test that wants to exercise the real request
 * dispatch — rather than grep the source for a guard — needs both sides framed.
 */

/** A fake Stream that replays `requests` to the handler and captures what it writes back. */
export function fakeLISHStream(requests: unknown[]) {
	const sent: Uint8Array[] = [];
	const aborts: Error[] = [];
	const stream = {
		id: 'test-stream',
		status: 'open',
		send(data: any): void {
			// it-length-prefixed hands back a Uint8ArrayList; keep only the payload.
			const list = data instanceof Uint8ArrayList ? data : new Uint8ArrayList(data);
			sent.push(list.subarray());
		},
		async close(): Promise<void> {},
		abort(err: Error): void {
			aborts.push(err);
		},
		async *[Symbol.asyncIterator]() {
			// The handler wraps us in a length-prefixed decoder, so frame each request.
			for (const req of requests) yield lpEncode.single(codecEncode(req));
		},
	};
	return { stream, sent, aborts };
}

/** Decode the length-prefixed frames the handler wrote back, in order. */
export async function decodeLISHResponses(sent: Uint8Array[]): Promise<any[]> {
	const out: any[] = [];
	for (const frame of sent) {
		const source = (async function* () {
			yield new Uint8ArrayList(frame);
		})();
		for await (const msg of lpDecode(source)) out.push(codecDecode(msg.subarray()));
	}
	return out;
}
