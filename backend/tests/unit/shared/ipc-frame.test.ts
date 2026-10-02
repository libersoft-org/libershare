import { describe, expect, test } from 'bun:test';
import { IPC_HEADER_SIZE, IPC_KIND, IPC_MAX_PAYLOAD_SIZE, IpcFrameDecoder, decodeIpcBody, encodeIpcBody, encodeIpcFrame } from '../../../../shared/src/ipc-frame.ts';

describe('private IPC framing', () => {
	test('matches the fixed big-endian wire format, including a payload subarray', () => {
		const data = new Uint8Array([99, 10, 20, 88]);
		const body = encodeIpcBody(IPC_KIND.Binary, 0x01020304, data.subarray(1, 3));
		expect([...body]).toEqual([5, 1, 2, 3, 4, 10, 20]);
		expect([...encodeIpcFrame(IPC_KIND.Binary, 0x01020304, data.subarray(1, 3))]).toEqual([0, 0, 0, 7, 5, 1, 2, 3, 4, 10, 20]);
		const padded = new Uint8Array([255, ...body, 255]);
		expect(decodeIpcBody(padded.subarray(1, -1))).toEqual({ kind: IPC_KIND.Binary, session: 0x01020304, payload: new Uint8Array([10, 20]) });
	});

	test('accepts fragmented prefixes and multiple coalesced frames without merging sessions', () => {
		const bytes = new Uint8Array([0, 0, 0, 5, 2, 0, 0, 0, 7, 0, 0, 0, 7, 4, 0, 0, 0, 8, 123, 125]);
		for (let split = 0; split <= bytes.byteLength; split++) {
			const decoder = new IpcFrameDecoder();
			const frames = [...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))];
			expect(frames).toEqual([
				{ kind: IPC_KIND.Open, session: 7, payload: new Uint8Array() },
				{ kind: IPC_KIND.Text, session: 8, payload: new Uint8Array([123, 125]) },
			]);
			decoder.finish();
		}
	});

	test.each([0, IPC_HEADER_SIZE - 1, IPC_HEADER_SIZE + IPC_MAX_PAYLOAD_SIZE + 1, 0xffffffff])('rejects invalid announced length %s before receiving its body', size => {
		const prefix = new Uint8Array(4);
		new DataView(prefix.buffer).setUint32(0, size);
		expect(() => new IpcFrameDecoder().push(prefix)).toThrow('Invalid IPC frame length');
	});

	test('rejects an unknown kind instead of dispatching it as an RPC request', () => {
		expect(() => new IpcFrameDecoder().push(new Uint8Array([0, 0, 0, 5, 255, 0, 0, 0, 1]))).toThrow('Unknown IPC frame kind');
	});

	test('distinguishes clean EOF from truncated prefixes and bodies', () => {
		new IpcFrameDecoder().finish();
		const full = new Uint8Array([0, 0, 0, 5, 2, 0, 0, 0, 1]);
		for (let length = 1; length < full.byteLength; length++) {
			const decoder = new IpcFrameDecoder();
			decoder.push(full.subarray(0, length));
			expect(() => decoder.finish()).toThrow('Truncated IPC frame');
		}
	});

	test.each([-1, 0.5, 0x100000000, Number.NaN])('refuses a session that would change during integer encoding: %s', session => {
		expect(() => encodeIpcBody(IPC_KIND.Text, session)).toThrow('Invalid IPC session');
	});
});
