import { describe, expect, it } from 'bun:test';
import { initSearchManager } from '../../../src/api/search.ts';
import { getSearchResultHandler } from '../../../src/protocol/lish-protocol.ts';
import type { LishSearchResult } from '@shared';
import { deriveLISHID } from '../../../src/lish/lish-id.ts';
import { TEST_NONCE } from '../helpers/signing.ts';

/**
 * Search rows are keyed by (LISH ID, reported publisher), and a row naming a publisher is kept
 * only when the ID is the one that publisher derives: nobody else can have signed under it.
 */

const A = '12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf';
const ID = deriveLISHID(A, TEST_NONCE);
const Q = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';

function manager() {
	const updates: LishSearchResult[][] = [];
	const network = {
		isRunning: () => true,
		getNodeInfo: () => ({ peerID: 'self' }),
		getPeers: () => [],
		getTopicPeers: () => [],
		onPeerConnect: () => () => {},
		onPeerSubscribe: () => () => {},
		broadcast: async (): Promise<void> => {},
		dialProtocolByPeerId: async () => {
			throw new Error('no dial in this test');
		},
	};
	const networks = { getNetwork: () => network, getRunningNetwork: () => network, list: () => [], isJoined: () => true };
	const search = initSearchManager(networks as any, { get: () => 30_000 } as any, (event, data) => {
		if (event === 'search:lishs:update') updates.push(structuredClone(data.lishs));
	});
	return { search, updates };
}

describe('search rows by (id, publisher)', () => {
	it('keeps an unsigned offer apart and drops a row whose publisher cannot own the ID', async () => {
		const { search, updates } = manager();
		const { searchID } = await search.startSearch({ query: ID.slice(0, 4) });
		const deliver = (peerID: string, publisher?: string, nonce: string | undefined = TEST_NONCE): void => getSearchResultHandler(searchID)?.({ searchID, peerID, lishs: [{ id: ID, name: 'Item', ...(publisher !== undefined ? { publisher, ...(nonce !== undefined ? { nonce } : {}) } : {}) }] });
		deliver('peer-1', A);
		// Another publisher under A's ID, A with another nonce, A without one: none derives this ID.
		deliver('peer-2', Q);
		deliver('peer-6', A, 'B' + TEST_NONCE.slice(1));
		deliver('peer-7', A, '');
		deliver('peer-3', A);
		deliver('peer-4');
		deliver('peer-5', 'not base58 0OIl');
		const rows = new Map<string, LishSearchResult>();
		for (const update of updates) for (const row of update) rows.set(`${row.id}|${row.publisher ?? ''}`, row);
		expect([...rows.keys()].sort()).toEqual([`${ID}|`, `${ID}|${A}`].sort());
		expect(rows.get(`${ID}|${A}`)!.peers.map(p => p.peerID)).toEqual(['peer-1', 'peer-3']);
		expect(rows.get(`${ID}|`)!.peers.map(p => p.peerID)).toEqual(['peer-4']);
		search.stopAll();
	});
});
