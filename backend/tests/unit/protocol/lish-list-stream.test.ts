import { afterEach, expect, test, spyOn } from 'bun:test';
import { type Stream } from '@libp2p/interface';
import { Uint8ArrayList } from 'uint8arraylist';
import { ErrorCodes, type IStoredLISH } from '@shared';
import { LISHClient, handleLISHProtocol, enableUpload, disableUpload, resetUploadState } from '../../../src/protocol/lish-protocol.ts';
import { encode, decode } from '../../../src/protocol/codec.ts';
import { MAX_LIST_RESPONSE_SIZE } from '../../../src/protocol/constants.ts';
afterEach(() => resetUploadState());

class Channel {
	private values: Uint8Array[] = [];
	private wake: (() => void) | undefined;
	private ended = false;
	push(value: Uint8Array): void { this.values.push(value); this.wake?.(); }
	end(): void { this.ended = true; this.wake?.(); }
	async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
		while (!this.ended || this.values.length) {
			const value = this.values.shift();
			if (value) yield value;
			else await new Promise<void>(resolve => { this.wake = resolve; });
		}
	}
}

function framePayload(frame: Uint8Array): Uint8Array {
	let prefix = 0;
	while (frame[prefix++]! & 0x80) {}
	return frame.subarray(prefix);
}

function duplex(onResponse?: (response: any) => void) {
	const left = new Channel(), right = new Channel();
	const responses: Uint8Array[] = [];
	const requests: any[] = [];
	const endpoint = (source: Channel, target: Channel, server: boolean): Stream => ({
		status: 'open', id: server ? 'server' : 'client',
		[Symbol.asyncIterator]: source[Symbol.asyncIterator].bind(source),
		send(frame: Uint8Array | Uint8ArrayList) {
			const bytes = Uint8Array.from(frame instanceof Uint8ArrayList ? frame.subarray() : frame);
			const payload = framePayload(bytes);
			if (server) { responses.push(payload); onResponse?.(decode(payload)); }
			else requests.push(decode(payload));
			target.push(bytes);
			return true;
		},
		async close() { left.end(); right.end(); },
		abort() { left.end(); right.end(); },
	}) as unknown as Stream;
	return { client: endpoint(left, right, false), server: endpoint(right, left, true), responses, requests, close: () => { left.end(); right.end(); } };
}

function shares(count: number): IStoredLISH[] {
	return Array.from({ length: count }, (_, i) => ({ id: `share-${i}`, name: `${i % 2 ? 'odd' : 'even'}-${'x'.repeat(4096)}`, created: '2026-01-01', checksumAlgo: 'sha256', chunkSize: 1, files: [] }));
}

test.each([900, 1200])('the real handler and client return all %i shares exactly once within 4 MiB pages', async count => {
	const list = shares(count);
	for (const item of list) enableUpload(item.id);
	let snapshots = 0;
	const wire = duplex();
	const serving = handleLISHProtocol(wire.server, { list: () => { snapshots++; return list; } } as never, 'remote', 'DIRECT', () => true);
	try {
		const result = await new LISHClient(wire.client).requestList();
		expect(result.map(item => item.id)).toEqual(list.map(item => item.id).reverse());
		expect(new Set(result.map(item => item.id)).size).toBe(count);
		expect(snapshots).toBe(1);
		expect(wire.responses.every(page => page.byteLength <= MAX_LIST_RESPONSE_SIZE)).toBe(true);
		expect(wire.responses.length).toBe(count === 900 ? 1 : 2);
	} finally { wire.close(); await serving; }
});

test('snapshot pagination keeps order while filtering withdrawn shares, and a fresh query refreshes it', async () => {
	let list = shares(1200);
	for (const item of list) enableUpload(item.id);
	let snapshots = 0;
	const wire = duplex(response => {
		if (response.nextCursor) {
			disableUpload('share-0');
			const added = { ...list[0]!, id: 'new-share' };
			enableUpload(added.id);
			list = [...list, added];
		}
	});
	const serving = handleLISHProtocol(wire.server, { list: () => { snapshots++; return list; } } as never, 'remote', 'DIRECT', () => true);
	try {
		const client = new LISHClient(wire.client);
		const all = await client.requestList();
		expect(all).toHaveLength(1199);
		expect(all.some(item => item.id === 'new-share' || item.id === 'share-0')).toBe(false);
		expect((await client.requestList('new-share')).map(item => item.id)).toEqual(['new-share']);
		expect(snapshots).toBe(2);
	} finally { wire.close(); await serving; }
});

test('authorization is checked before the snapshot and on every continuation', async () => {
	const list = shares(1200);
	for (const item of list) enableUpload(item.id);
	let authorized = true;
	let reads = 0;
	const wire = duplex(response => { if (response.nextCursor) authorized = false; });
	const serving = handleLISHProtocol(wire.server, { list: () => { reads++; return list; } } as never, 'remote', 'DIRECT', () => true, () => authorized);
	try {
		await expect(new LISHClient(wire.client).requestList()).rejects.toMatchObject({ code: ErrorCodes.PEER_LISTING_NOT_AUTHORIZED });
		expect(reads).toBe(1);
		expect(decode<Record<string, unknown>>(wire.responses[1]!)).toEqual({ type: 'getLishs-result', error: ErrorCodes.PEER_LISTING_NOT_AUTHORIZED });
	} finally { wire.close(); await serving; }
	const denied = duplex();
	const rejected = handleLISHProtocol(denied.server, { list: () => { throw new Error('unauthorized snapshot'); } } as never, 'remote', 'DIRECT', () => false);
	try { await expect(new LISHClient(denied.client).requestList()).rejects.toMatchObject({ code: ErrorCodes.PEER_LISTING_NOT_AUTHORIZED }); }
	finally { denied.close(); await rejected; }
});

test('legacy requests get a complete small response or an explicit error, never a truncated list', async () => {
	for (const count of [2, 1200]) {
		const list = shares(count);
		for (const item of list) enableUpload(item.id);
		const wire = duplex();
		const serving = handleLISHProtocol(wire.server, { list: () => list } as never, 'remote', 'DIRECT', () => true);
		try {
			const { encode: prefix } = await import('it-length-prefixed');
			wire.client.send(prefix.single(encode({ type: 'getLishs' })));
			const iterator = wire.client[Symbol.asyncIterator]();
			await iterator.next();
			const reply = decode<any>(wire.responses[0]!);
			if (count === 2) expect(reply.lishs.map((entry: any) => entry.id)).toEqual(['share-1', 'share-0']);
			else expect(reply).toEqual({ type: 'getLishs-result', error: 'PEER_LIST_TOO_LARGE' });
			expect(wire.responses[0]!.byteLength).toBeLessThanOrEqual(MAX_LIST_RESPONSE_SIZE);
		} finally { wire.close(); await serving; }
	}
});

test('cancellation interrupts a stalled peer and aborts the client stream', async () => {
	const wire = duplex();
	const abort = new AbortController();
	const client = new LISHClient(wire.client);
	const stopped = spyOn(wire.client, 'abort');
	const request = client.requestList(undefined, abort.signal);
	abort.abort();
	await expect(request).rejects.toMatchObject({ code: ErrorCodes.PEER_UNREACHABLE });
	expect(stopped).toHaveBeenCalled();
	wire.close();
});
