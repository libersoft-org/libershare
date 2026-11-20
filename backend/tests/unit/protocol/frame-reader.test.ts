import { describe, expect, it } from 'bun:test';
import { encode as lpEncode } from 'it-length-prefixed';
import { Uint8ArrayList } from 'uint8arraylist';
import { FrameEndedError, FrameReader } from '../../../src/protocol/frame-reader.ts';

const accept = (): void => {};

/** The frames as the sending side puts them on the wire, in one array. */
function wire(...frames: Uint8Array[]): Uint8Array {
	return new Uint8ArrayList(...frames.map(f => lpEncode.single(f))).subarray();
}

async function* pieces(...parts: Array<Uint8Array | Uint8ArrayList>): AsyncGenerator<Uint8Array | Uint8ArrayList> {
	for (const part of parts) yield part;
}

function payload(length: number, seed: number): Uint8Array {
	return Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 0xff);
}

describe('FrameReader', () => {
	it('reads frames the sender wrote, whole and in order', async () => {
		const a = payload(5, 1);
		const b = payload(300, 2); // two-byte length prefix
		const reader = new FrameReader(pieces(wire(a, b)));
		expect(await reader.next(accept)).toEqual(a);
		expect(await reader.next(accept)).toEqual(b);
		expect(await reader.next(accept)).toBeUndefined();
	});

	it('assembles a frame that arrives in pieces cut anywhere, also inside the length prefix', async () => {
		const a = payload(70_000, 3); // three-byte length prefix
		const b = payload(9, 4);
		const bytes = wire(a, b);
		for (const cut of [1, 2, 3, 4, 1000, bytes.length - 10, bytes.length - 1]) {
			const reader = new FrameReader(pieces(bytes.subarray(0, cut), bytes.subarray(cut)));
			expect(await reader.next(accept)).toEqual(a);
			expect(await reader.next(accept)).toEqual(b);
			expect(await reader.next(accept)).toBeUndefined();
		}
	});

	it('takes pieces that come as a list of arrays', async () => {
		const a = payload(1000, 5);
		const bytes = wire(a);
		const list = new Uint8ArrayList(bytes.subarray(0, 1), bytes.subarray(1, 400), bytes.subarray(400));
		expect(await new FrameReader(pieces(list)).next(accept)).toEqual(a);
	});

	it('returns each frame in a buffer of its own, exactly its length', async () => {
		const a = payload(64, 6);
		const reader = new FrameReader(pieces(wire(a, payload(64, 7))));
		const first = (await reader.next(accept))!;
		const second = (await reader.next(accept))!;
		expect(first.byteLength).toBe(64);
		expect(first.buffer.byteLength).toBe(64);
		expect(first.buffer).not.toBe(second.buffer);
	});

	it('reports the announced length before reading the body, and a refusal stops the read', async () => {
		const bytes = wire(payload(5000, 8));
		let pulled = 0;
		async function* counted(): AsyncGenerator<Uint8Array> {
			for (const piece of [bytes.subarray(0, 2), bytes.subarray(2)]) {
				pulled++;
				yield piece;
			}
		}
		const seen: number[] = [];
		const refuse = (length: number): void => {
			seen.push(length);
			throw new Error('too long');
		};
		await expect(new FrameReader(counted()).next(refuse)).rejects.toThrow('too long');
		expect(seen).toEqual([5000]);
		expect(pulled).toBe(1);
	});

	it('distinguishes a stream that ended between frames from one that ended inside a frame', async () => {
		const bytes = wire(payload(300, 9));
		expect(await new FrameReader(pieces()).next(accept)).toBeUndefined();
		await expect(new FrameReader(pieces(bytes.subarray(0, 1))).next(accept)).rejects.toBeInstanceOf(FrameEndedError);
		await expect(new FrameReader(pieces(bytes.subarray(0, 100))).next(accept)).rejects.toBeInstanceOf(FrameEndedError);
	});

	it('refuses a length prefix that never ends', async () => {
		await expect(new FrameReader(pieces(new Uint8Array(9).fill(0x80))).next(accept)).rejects.toThrow('prefix too long');
	});

	it('reads an empty frame', async () => {
		const reader = new FrameReader(pieces(wire(new Uint8Array(0), payload(3, 10))));
		expect(await reader.next(accept)).toEqual(new Uint8Array(0));
		expect(await reader.next(accept)).toEqual(payload(3, 10));
	});
});
