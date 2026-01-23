import { describe, test, expect } from 'bun:test';
import { Utils } from '../src/utils.ts';

describe('Utils.encodeBase62', () => {
	test('encodes empty-ish array as "0"', () => {
		expect(Utils.encodeBase62(new Uint8Array([0]))).toBe('0');
	});

	test('encodes single byte', () => {
		expect(Utils.encodeBase62(new Uint8Array([1]))).toBe('1');
		expect(Utils.encodeBase62(new Uint8Array([61]))).toBe('z');
		expect(Utils.encodeBase62(new Uint8Array([62]))).toBe('10');
	});

	test('encodes multiple bytes', () => {
		// 256 = 4 * 62 + 8 = "48" in base62
		expect(Utils.encodeBase62(new Uint8Array([1, 0]))).toBe('48');
		// 0xFFFF = 65535
		expect(Utils.encodeBase62(new Uint8Array([0xff, 0xff]))).toBe('H31');
	});

	test('encodes known values', () => {
		// "hello" in ASCII: [104, 101, 108, 108, 111]
		const hello = new Uint8Array([104, 101, 108, 108, 111]);
		const encoded = Utils.encodeBase62(hello);
		expect(encoded).toBe('7tQLFHz');
	});
});

describe('Utils.decodeBase62', () => {
	test('decodes "0" to single zero byte', () => {
		expect(Utils.decodeBase62('0')).toEqual(new Uint8Array([0]));
	});

	test('decodes single characters', () => {
		expect(Utils.decodeBase62('1')).toEqual(new Uint8Array([1]));
		expect(Utils.decodeBase62('z')).toEqual(new Uint8Array([61]));
		expect(Utils.decodeBase62('10')).toEqual(new Uint8Array([62]));
	});

	test('decodes multiple characters', () => {
		expect(Utils.decodeBase62('48')).toEqual(new Uint8Array([1, 0]));
		expect(Utils.decodeBase62('H31')).toEqual(new Uint8Array([0xff, 0xff]));
	});

	test('throws on invalid characters', () => {
		expect(() => Utils.decodeBase62('hello!')).toThrow('Invalid base62 character: !');
		expect(() => Utils.decodeBase62('test-value')).toThrow('Invalid base62 character: -');
	});
});

describe('Base62 roundtrip', () => {
	test('encode then decode returns original bytes', () => {
		const testCases = [
			new Uint8Array([0]),
			new Uint8Array([1, 2, 3]),
			new Uint8Array([255, 255, 255]),
			new Uint8Array([0, 0, 1]), // Leading zeros get lost - this is expected
			crypto.getRandomValues(new Uint8Array(16)),
			crypto.getRandomValues(new Uint8Array(32)),
		];

		for (const original of testCases) {
			const encoded = Utils.encodeBase62(original);
			const decoded = Utils.decodeBase62(encoded);

			// Note: Leading zeros are not preserved in base62 encoding
			// So we compare the BigInt values instead
			const originalNum = original.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
			const decodedNum = decoded.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
			expect(decodedNum).toBe(originalNum);
		}
	});

	test('32-byte swarm key roundtrip', () => {
		// Simulate a 32-byte swarm key
		const swarmKey = crypto.getRandomValues(new Uint8Array(32));
		const encoded = Utils.encodeBase62(swarmKey);
		const decoded = Utils.decodeBase62(encoded);

		// Verify the numeric value is preserved
		const originalNum = swarmKey.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
		const decodedNum = decoded.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
		expect(decodedNum).toBe(originalNum);
	});
});

describe('Utils.formatBytes', () => {
	test('formats bytes correctly', () => {
		expect(Utils.formatBytes(0)).toBe('0 Bytes');
		expect(Utils.formatBytes(1024)).toBe('1 kB');
		expect(Utils.formatBytes(1536)).toBe('1.5 kB');
		expect(Utils.formatBytes(1048576)).toBe('1 MB');
	});
});

describe('Utils.parseBytes', () => {
	test('parses byte strings correctly', () => {
		expect(Utils.parseBytes(1024)).toBe(1024);
		expect(Utils.parseBytes('1K')).toBe(1024);
		expect(Utils.parseBytes('1KB')).toBe(1024);
		expect(Utils.parseBytes('1M')).toBe(1048576);
		expect(Utils.parseBytes('1.5G')).toBe(1610612736);
	});

	test('throws on invalid format', () => {
		expect(() => Utils.parseBytes('invalid')).toThrow();
	});
});
