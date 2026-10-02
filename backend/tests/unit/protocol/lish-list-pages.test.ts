import { expect, test, spyOn } from 'bun:test';
import { ErrorCodes, type IStoredLISH } from '@shared';
import { LISHListPages, receiveLISHList } from '../../../src/protocol/lish-list-pages.ts';
import { encode, decode } from '../../../src/protocol/codec.ts';
import { MAX_LIST_RESPONSE_SIZE } from '../../../src/protocol/constants.ts';

function shares(count: number): IStoredLISH[] {
	return Array.from({ length: count }, (_, i) => ({ id: `share-${i}`, name: `${i % 2 ? 'odd' : 'even'}-${'x'.repeat(4096)}`, created: '2026-01-01', checksumAlgo: 'sha256', chunkSize: 1, files: [] }));
}

test('continuations reject stale, cross-query and replayed cursors', () => {
	const pages = new LISHListPages();
	const list = shares(1200);
	const first = decode<any>(
		pages.respond(
			{ type: 'getLishs', page: true },
			() => list,
			() => true
		)
	);
	const cursor = first.nextCursor;
	pages.respond(
		{ type: 'getLishs', page: true, query: 'different' },
		() => list,
		() => true
	);
	expect(() =>
		pages.respond(
			{ type: 'getLishs', page: true, cursor },
			() => list,
			() => true
		)
	).toThrow();
	const next = decode<any>(
		pages.respond(
			{ type: 'getLishs', page: true },
			() => list,
			() => true
		)
	);
	expect(() =>
		pages.respond(
			{ type: 'getLishs', page: true, query: 'different', cursor: next.nextCursor },
			() => list,
			() => true
		)
	).toThrow();
	const fresh = decode<any>(
		pages.respond(
			{ type: 'getLishs', page: true },
			() => list,
			() => true
		)
	);
	pages.respond(
		{ type: 'getLishs', page: true, cursor: fresh.nextCursor },
		() => list,
		() => true
	);
	expect(() =>
		pages.respond(
			{ type: 'getLishs', page: true, cursor: fresh.nextCursor },
			() => list,
			() => true
		)
	).toThrow();
});

test('single entries that cannot fit a page are rejected explicitly', () => {
	const pages = new LISHListPages();
	const list = [{ ...shares(1)[0]!, name: 'x'.repeat(MAX_LIST_RESPONSE_SIZE) }];
	expect(() =>
		pages.respond(
			{ type: 'getLishs', page: true },
			() => list,
			() => true
		)
	).toThrow('PEER_LIST_TOO_LARGE');
});

test('a lower configured frame limit still yields bounded complete pages', () => {
	const pages = new LISHListPages();
	const list = shares(3);
	let cursor: string | undefined;
	const ids: string[] = [];
	do {
		const raw = pages.respond(
			{ type: 'getLishs', page: true, ...(cursor ? { cursor } : {}) },
			() => list,
			() => true,
			5000
		);
		expect(raw.byteLength).toBeLessThanOrEqual(5000);
		const reply = decode<any>(raw);
		ids.push(...reply.lishs.map((entry: any) => entry.id));
		cursor = reply.nextCursor;
	} while (cursor);
	expect(ids).toEqual(['share-2', 'share-1', 'share-0']);
});

test.each([{ page: false }, { page: true, cursor: 12 }, { cursor: 'unexpected' }, { page: true, query: [] }])('malformed pagination requests are refused before snapshot allocation: %j', fields => {
	const pages = new LISHListPages();
	let reads = 0;
	expect(() =>
		pages.respond(
			{ type: 'getLishs', ...fields } as never,
			() => {
				reads++;
				return [];
			},
			() => true
		)
	).toThrow();
	expect(reads).toBe(0);
});

test('the client accepts a complete legacy response and rejects aggregate overflow without partial results', async () => {
	expect(await receiveLISHList(undefined, async () => encode({ type: 'getLishs-result', lishs: [{ id: 'legacy' }] }), 1024)).toEqual([{ id: 'legacy' }]);
	let count = 0;
	const token = crypto.randomUUID();
	await expect(
		receiveLISHList(
			undefined,
			async () => {
				const index = count++;
				return encode({ type: 'getLishs-result', page: true, offset: index, lishs: [{ id: String(index), name: 'x'.repeat(100) }], ...(index === 0 ? { nextCursor: `${token}:1` } : {}) });
			},
			300
		)
	).rejects.toMatchObject({ code: 'PEER_LIST_TOO_LARGE' });
	expect(count).toBe(2);
});

test.each([{ lishs: 'not an array' }, { lishs: new Uint8Array([1]) }, { lishs: [{ id: 1 }] }, { lishs: [{ id: 'x' }], page: true, offset: 0, nextCursor: `${crypto.randomUUID()}:0` }, { lishs: [], page: true, offset: 0, nextCursor: `${crypto.randomUUID()}:1` }, { lishs: [{ id: 'x' }], page: false, offset: 0 }])('malformed pages cannot produce a list: %j', async response => {
	await expect(receiveLISHList(undefined, async () => encode({ type: 'getLishs-result', ...response }), 10000)).rejects.toMatchObject({ code: ErrorCodes.PEER_INVALID_REQUEST });
});

test('a repeated page cannot loop or duplicate entries', async () => {
	const cursor = `${crypto.randomUUID()}:1`;
	let count = 0;
	await expect(
		receiveLISHList(
			undefined,
			async () => {
				count++;
				return encode({ type: 'getLishs-result', page: true, offset: 0, nextCursor: cursor, lishs: [{ id: 'x' }] });
			},
			10000
		)
	).rejects.toMatchObject({ code: ErrorCodes.PEER_INVALID_REQUEST });
	expect(count).toBe(2);
});

test('a duplicate entry on a forward-moving page is rejected', async () => {
	const cursor = `${crypto.randomUUID()}:1`;
	let offset = 0;
	await expect(receiveLISHList(undefined, async () => encode({ type: 'getLishs-result', page: true, offset: offset++, ...(offset === 1 ? { nextCursor: cursor } : {}), lishs: [{ id: 'duplicate' }] }), 10000)).rejects.toMatchObject({ code: ErrorCodes.PEER_INVALID_REQUEST });
});

test('all pages share the original request deadline', async () => {
	let now = 1000;
	const clock = spyOn(performance, 'now').mockImplementation(() => now);
	let calls = 0;
	try {
		await expect(
			receiveLISHList(
				undefined,
				async () => {
					calls++;
					now += 15001;
					return encode({ type: 'getLishs-result', page: true, offset: 0, nextCursor: `${crypto.randomUUID()}:1`, lishs: [{ id: 'x' }] });
				},
				10000
			)
		).rejects.toMatchObject({ code: ErrorCodes.PEER_UNREACHABLE });
		expect(calls).toBe(1);
	} finally {
		clock.mockRestore();
	}
});
