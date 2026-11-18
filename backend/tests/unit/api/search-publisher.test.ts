import { describe, expect, it } from 'bun:test';
import { initSearchManager } from '../../../src/api/search.ts';
import { getSearchResultHandler } from '../../../src/protocol/lish-protocol.ts';
import type { LishSearchResult } from '@shared';

/**
 * Search rows are keyed by (LISH ID, reported publisher): an offer of another publisher under
 * the same ID stays a separate row and never merges into the original publisher's one.
 */

const ID = 'e0000000-0000-4000-8000-000000000005';
const A = '12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf';
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
	it('keeps another publisher under the same ID apart and drops a malformed publisher', async () => {
		const { search, updates } = manager();
		const { searchID } = await search.startSearch({ query: 'e000' });
		const deliver = (peerID: string, publisher?: string): void => getSearchResultHandler(searchID)?.({ searchID, peerID, lishs: [{ id: ID, name: 'Item', ...(publisher !== undefined ? { publisher } : {}) }] });
		deliver('peer-1', A);
		deliver('peer-2', Q);
		deliver('peer-3', A);
		deliver('peer-4');
		deliver('peer-5', 'not base58 0OIl');
		const rows = new Map<string, LishSearchResult>();
		for (const update of updates) for (const row of update) rows.set(`${row.id}|${row.publisher ?? ''}`, row);
		expect([...rows.keys()].sort()).toEqual([`${ID}|`, `${ID}|${A}`, `${ID}|${Q}`].sort());
		expect(rows.get(`${ID}|${A}`)!.peers.map(p => p.peerID)).toEqual(['peer-1', 'peer-3']);
		expect(rows.get(`${ID}|${Q}`)!.peers.map(p => p.peerID)).toEqual(['peer-2']);
		expect(rows.get(`${ID}|`)!.peers.map(p => p.peerID)).toEqual(['peer-4']);
		search.stopAll();
	});
});
