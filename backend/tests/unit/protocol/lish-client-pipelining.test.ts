import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { encode as lpEncode } from 'it-length-prefixed';
import type { IStoredLISH } from '@shared';
import { LISHClient } from '../../../src/protocol/lish-protocol.ts';
import { encode as codecEncode } from '../../../src/protocol/codec.ts';

/**
 * Several requests in flight on one LISHClient: replies carry no request ID, so each read has to
 * start — with its own frame limit, progress hooks and timeout — only once the replies before
 * it were read.
 */

/** A stream whose replies the test pushes in whole frames or arbitrary byte slices. */
function scriptedStream(): { stream: any; sent: () => number; push: (bytes: Uint8Array) => void } {
	const queue: Uint8Array[] = [];
	let wake: (() => void) | undefined;
	let sent = 0;
	const stream = {
		status: 'open',
		send() {
			sent++;
			return true;
		},
		close: async () => {},
		abort() {
			this.status = 'aborted';
		},
		async *[Symbol.asyncIterator]() {
			for (;;) {
				while (queue.length === 0) await new Promise<void>(resolve => (wake = resolve));
				yield queue.shift()!;
			}
		},
	};
	const push = (bytes: Uint8Array): void => {
		queue.push(bytes);
		wake?.();
	};
	return { stream, sent: () => sent, push };
}

const frame = (reply: unknown): Uint8Array => lpEncode.single(codecEncode(reply)).subarray();

function manifest(id: string): IStoredLISH {
	return { id, created: new Date().toISOString(), chunkSize: 1024, checksumAlgo: 'sha256', files: [{ path: `${id}.bin`, size: 1024, checksums: ['h1'] }] };
}

afterEach(() => {
	// spyOn restores itself only through mockRestore; keep every test independent.
	(globalThis.setTimeout as any).mockRestore?.();
});

describe('LISHClient pipelined requests', () => {
	it('checks each reply against the limit of its own request', async () => {
		const { stream, sent, push } = scriptedStream();
		const client = new LISHClient(stream);
		const chunk = client.requestChunk('lish-a' as any, 'c1' as any);
		const ack = client.announceHave('lish-a' as any, 'all', []);
		expect(sent()).toBe(2);
		const data = new Uint8Array(1024 * 1024).fill(7);
		push(frame({ data }));
		push(frame({ ok: true }));
		expect((await chunk).length).toBe(data.length);
		await ack;
	});

	it('starts the timeout of a request only when its reply is next', async () => {
		const timers = spyOn(globalThis, 'setTimeout');
		const readTimers = (): number => timers.mock.calls.filter(call => call[1] === 30000).length;
		const { stream, sent, push } = scriptedStream();
		const client = new LISHClient(stream);
		const replies = [1, 2, 3].map(i => client.requestChunk('lish-a' as any, `c${i}` as any));
		expect(sent()).toBe(3);
		await Bun.sleep(0);
		expect(readTimers()).toBe(1);
		push(frame({ data: new Uint8Array(16).fill(1) }));
		expect((await replies[0])[0]).toBe(1);
		await Bun.sleep(0);
		expect(readTimers()).toBe(2);
		push(frame({ data: new Uint8Array(16).fill(2) }));
		push(frame({ data: new Uint8Array(16).fill(3) }));
		expect((await replies[1])[0]).toBe(2);
		expect((await replies[2])[0]).toBe(3);
	});

	it('reports manifest progress only for the bytes of its own reply', async () => {
		const { stream, push } = scriptedStream();
		const client = new LISHClient(stream);
		const progress: Array<Array<[number, number]>> = [[], []];
		const first = client.requestManifest('lish-one' as any, (r, t) => progress[0]!.push([r, t]));
		const second = client.requestManifest('lish-two' as any, (r, t) => progress[1]!.push([r, t]));
		const frames = [frame({ manifest: manifest('lish-one') }), frame({ manifest: manifest('lish-two') })];
		// The first reply split mid-frame, the second glued to the first one's tail.
		const glued = new Uint8Array(frames[0]!.length - 1 + frames[1]!.length);
		glued.set(frames[0]!.subarray(1));
		glued.set(frames[1]!, frames[0]!.length - 1);
		push(frames[0]!.subarray(0, 1));
		push(glued);
		expect((await first).id).toBe('lish-one');
		expect((await second).id).toBe('lish-two');
		const bodies = frames.map(f => f.length - 2); // both bodies are under 16 KiB: two-byte varint prefix
		expect(progress[0]!.at(-1)).toEqual([bodies[0]!, bodies[0]!]);
		expect(progress[1]!.at(-1)).toEqual([bodies[1]!, bodies[1]!]);
	});
});
