import { afterEach, describe, expect, it } from 'bun:test';
import { handleLISHProtocol, initUploadState, resetUploadState, type LISHGetLishsResponse } from '../../../src/protocol/lish-protocol.ts';
import { MAX_SEARCH_QUERY_LENGTH } from '../../../src/protocol/constants.ts';
import { decodeLISHResponses as responses, fakeLISHStream as fakeStream } from '../helpers/lish-stream.ts';

/**
 * The unicast `getLishs` query and the pubsub `searchLishs` query end up doing the same
 * work — lowercase once, then substring-match the id and the name of every advertised
 * LISH — so they must share one bound. The pubsub path had one and this one did not.
 *
 * These drive the real protocol handler over a fake stream rather than asserting on the
 * source text, so they still hold if the guard moves.
 */

const SHARED_LISH_ID = 'bbbbbbbb-2222-4333-8444-555555555555';
const PEER = 'peer-member';

/**
 * Counts catalog scans. An oversized query yields no matches either way, so an empty
 * result proves nothing — what the bound has to prevent is the scan itself, which is
 * the work an attacker is buying.
 */
function countingDataServer() {
	const scans = { count: 0 };
	const dataServer = {
		list: () => {
			scans.count++;
			return [{ id: SHARED_LISH_ID, name: 'Shared', files: [{ size: 10 }] }];
		},
	} as any;
	return { dataServer, scans };
}

const allowAll = (): boolean => true;

describe('getLishs query bound', () => {
	afterEach(() => {
		resetUploadState();
	});

	it('scans the catalog for a query at the bound', async () => {
		initUploadState(new Set([SHARED_LISH_ID]), () => {});
		const { dataServer, scans } = countingDataServer();
		const atBound = SHARED_LISH_ID.slice(0, 8).padEnd(MAX_SEARCH_QUERY_LENGTH, SHARED_LISH_ID.slice(0, 8)).slice(0, 8);
		const { stream, sent } = fakeStream([{ type: 'getLishs', query: atBound }]);

		await handleLISHProtocol(stream as any, dataServer, PEER, 'DIRECT', allowAll, allowAll);

		const [res] = (await responses(sent)) as Array<Extract<LISHGetLishsResponse, { lishs: unknown }>>;
		expect(scans.count).toBe(1);
		expect(res!.lishs.map(l => l.id)).toEqual([SHARED_LISH_ID]);
	});

	it('refuses a query longer than the bound without scanning the catalog', async () => {
		initUploadState(new Set([SHARED_LISH_ID]), () => {});
		const { dataServer, scans } = countingDataServer();
		const oversized = 'x'.repeat(MAX_SEARCH_QUERY_LENGTH + 1);
		const { stream, sent } = fakeStream([{ type: 'getLishs', query: oversized }]);

		await handleLISHProtocol(stream as any, dataServer, PEER, 'DIRECT', allowAll, allowAll);

		const [res] = (await responses(sent)) as Array<Extract<LISHGetLishsResponse, { lishs: unknown }>>;
		expect(scans.count).toBe(0);
		expect(res!.type).toBe('getLishs-result');
		expect(res!.lishs).toEqual([]);
	});
});
