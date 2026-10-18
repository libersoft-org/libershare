import { expect, test } from 'bun:test';
import { initSearchManager } from '../../../src/api/search.ts';
import { getSearchResultHandler } from '../../../src/protocol/lish-protocol.ts';

const LISH_ID = 'dddddddd-3333-4444-8555-666666666666';

function node(peerID: string, sent: Array<{ topic: string; searchID: string }>) {
	return {
		isRunning: () => true,
		getNodeInfo: () => ({ peerID }),
		getPeers: (): string[] => [],
		getTopicPeers: (): string[] => [],
		onPeerConnect: () => () => {},
		broadcast: async (topic: string, message: { searchID: string }): Promise<void> => {
			sent.push({ topic, searchID: message.searchID });
		},
	};
}

/** One search ID on the public and a protected lishnet told a member of both that the two identities were one machine. */
test('each node sends a search under its own ID and the answers reach one session', async () => {
	const sent: Array<{ topic: string; searchID: string }> = [];
	const publicNode = node('public-peer', sent);
	const protectedNode = node('protected-peer', sent);
	const events: Array<{ event: string; data: any }> = [];
	const networks = {
		getNetwork: () => publicNode,
		getRunningNetwork: () => publicNode,
		protectedNodes: () => [protectedNode],
		networkFor: (id: string) => (id === 'protected' ? protectedNode : publicNode),
		get: (id: string) => (id === 'protected' ? { overlay: {} } : undefined),
		list: () => [
			{ networkID: 'public', enabled: true },
			{ networkID: 'protected', enabled: true, overlay: {} },
		],
		isJoined: () => true,
	};
	const manager = initSearchManager(networks as any, { get: () => 30_000 } as any, (event, data) => events.push({ event, data }));
	const { searchID } = await manager.startSearch({ query: 'shared' });
	expect(sent).toHaveLength(2);
	const [onPublic, onProtected] = sent;
	expect(onPublic!.searchID).toBe(searchID);
	expect(onProtected!.searchID).not.toBe(searchID);
	// An answer to the protected node's ID is part of the same search for the UI.
	getSearchResultHandler(onProtected!.searchID)?.({ searchID: onProtected!.searchID, peerID: 'member', lishs: [{ id: LISH_ID, name: 'Shared' }] });
	expect(events.find(e => e.event === 'search:lishs:update')?.data.searchID).toBe(searchID);
	manager.cancelSearch({ searchID });
	expect(getSearchResultHandler(onProtected!.searchID)).toBeUndefined();
	manager.stopAll();
});
