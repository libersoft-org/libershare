import { describe, expect, it } from 'bun:test';
import { checkMessageShape } from '../../../src/protocol/message-budget.ts';
import { decode, encode } from '../../../src/protocol/codec.ts';

/**
 * A frame is checked token by token before msgpackr builds objects from it: one byte of
 * MessagePack can become a whole JS object, so a byte limit alone does not bound the heap.
 */
describe('checkMessageShape', () => {
	const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

	it('passes every shape the encoder produces', () => {
		const manifest = { manifest: { id: 'x', name: undefined, created: new Date(0), chunkSize: 1 << 20, files: [{ path: 'a', size: 2 ** 40, checksums: ['c'.repeat(64)] }] }, data: new Uint8Array(70_000), n: -3.5, big: 2 ** 60, t: true, z: null, s: 's'.repeat(70_000) };
		const wire = encode(manifest);
		expect(() => checkMessageShape(wire)).not.toThrow();
		expect(decode<typeof manifest>(wire).manifest.files[0]!.size).toBe(2 ** 40);
		for (const value of [0, -1, 255, 70_000, 2 ** 33, [], {}, [[[]]], '']) expect(() => checkMessageShape(encode(value))).not.toThrow();
	});

	it('refuses a flood of empty objects past the value budget', () => {
		const count = 1000;
		const flood = new Uint8Array(5 + count).fill(0x80);
		flood.set([0xdd, 0, 0, count >> 8, count & 0xff]);
		expect(() => checkMessageShape(flood, { maxTokens: 500, maxDepth: 16 })).toThrow('too many values');
		expect(() => checkMessageShape(flood, { maxTokens: 2000, maxDepth: 16 })).not.toThrow();
	});

	it('refuses a container that declares more values than bytes remain', () => {
		expect(() => checkMessageShape(bytes(0xdd, 0xff, 0xff, 0xff, 0xf0, 0xc0))).toThrow('more values than the message holds');
		expect(() => checkMessageShape(bytes(0xdf, 0x80, 0, 0, 0, 0xc0, 0xc0))).toThrow('more values than the message holds');
	});

	it('refuses deep nesting without using the call stack', () => {
		expect(() => checkMessageShape(new Uint8Array(200_000).fill(0x91))).toThrow('nests too deep');
		const ok = new Uint8Array(18).fill(0x91);
		ok[17] = 0xc0;
		expect(() => checkMessageShape(ok)).toThrow('nests too deep');
		expect(() => checkMessageShape(ok.subarray(1))).not.toThrow();
	});

	it('refuses truncation, trailing bytes, reserved bytes and unknown extensions', () => {
		expect(() => checkMessageShape(bytes(0xa5, 0x61))).toThrow('truncated');
		expect(() => checkMessageShape(bytes(0xc4, 0x10, 0x00))).toThrow('truncated');
		expect(() => checkMessageShape(bytes(0x92, 0xc0))).toThrow('more values than the message holds');
		expect(() => checkMessageShape(bytes(0x92, 0xa1, 0x61))).toThrow('truncated');
		expect(() => checkMessageShape(bytes(0xc0, 0xc0))).toThrow('bytes after the message');
		expect(() => checkMessageShape(bytes(0xc1))).toThrow('reserved');
		expect(() => checkMessageShape(bytes(0xd4, 0x78, 0x00))).toThrow('unsupported extension');
		expect(() => checkMessageShape(bytes(0xc7, 0x02, 0x65, 0x61, 0x62))).toThrow('unsupported extension');
		expect(() => checkMessageShape(new Uint8Array(0))).toThrow('truncated');
	});

	it('guards decode itself', () => {
		expect(() => decode(new Uint8Array(200_000).fill(0x91))).toThrow('nests too deep');
	});
});
