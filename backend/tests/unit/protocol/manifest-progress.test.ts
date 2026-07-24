import { describe, it, expect } from 'bun:test';
import { encode as lpEncode } from 'it-length-prefixed';
import { Uint8ArrayList } from 'uint8arraylist';
import { LISHClient } from '../../../src/protocol/lish-protocol.ts';
import { encode as codecEncode } from '../../../src/protocol/codec.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake libp2p stream: yields `frame` split into fixed-size pieces. */
function makeManifestStream(frame: Uint8Array, pieceSize: number): any {
	return {
		status: 'open',
		send(): void {},
		async close(): Promise<void> {},
		async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
			for (let i = 0; i < frame.length; i += pieceSize) yield frame.subarray(i, i + pieceSize);
		},
	};
}

/** Build a length-prefixed msgpack frame for a `{ manifest }` response. */
function buildManifestFrame(manifest: unknown): { frame: Uint8Array; dataLen: number } {
	const data = codecEncode({ manifest });
	const prefixed = lpEncode.single(data);
	const frame = prefixed instanceof Uint8Array ? prefixed : (prefixed as Uint8ArrayList).subarray();
	return { frame, dataLen: data.length };
}

const MANIFEST = {
	id: 'lish-progress-test',
	name: 'progress',
	files: Array.from({ length: 20 }, (_, i) => ({ path: `dir/file-${i}.bin`, size: 1000 + i })),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LISHClient.requestManifest – transfer progress', () => {
	it('reports total from onLength and a growing received, ending at (total, total)', async () => {
		const { frame, dataLen } = buildManifestFrame(MANIFEST);
		const client = new LISHClient(makeManifestStream(frame, 8));
		const events: Array<[number, number]> = [];

		const manifest = await client.requestManifest('lish-progress-test' as any, (received, total) => events.push([received, total]));

		// Manifest still parses correctly with progress enabled.
		expect((manifest as { id: string }).id).toBe('lish-progress-test');

		// At least one intermediate emit plus the guaranteed final one.
		expect(events.length).toBeGreaterThanOrEqual(2);
		// Every emit carries the total decoded from the length prefix (onLength).
		for (const [, total] of events) expect(total).toBe(dataLen);
		// received never decreases across emits.
		for (let i = 1; i < events.length; i++) expect(events[i]![0]).toBeGreaterThanOrEqual(events[i - 1]![0]);
		// A partial emit (received < total) proves progress was tracked mid-transfer.
		expect(events.some(([received, total]) => received < total)).toBe(true);
		// The final emit is a clean 100%.
		expect(events[events.length - 1]).toEqual([dataLen, dataLen]);
	});

	it('never emits received above total (varint prefix is clamped away)', async () => {
		const { frame, dataLen } = buildManifestFrame(MANIFEST);
		const client = new LISHClient(makeManifestStream(frame, 4));
		const events: Array<[number, number]> = [];

		await client.requestManifest('lish-progress-test' as any, (received, total) => events.push([received, total]));

		for (const [received, total] of events) {
			expect(total).toBe(dataLen);
			expect(received).toBeLessThanOrEqual(total);
		}
	});

	it('works without an onProgress callback (backward compatible)', async () => {
		const { frame } = buildManifestFrame(MANIFEST);
		const client = new LISHClient(makeManifestStream(frame, 8));

		const manifest = await client.requestManifest('lish-progress-test' as any);

		expect((manifest as { id: string }).id).toBe('lish-progress-test');
	});
});
