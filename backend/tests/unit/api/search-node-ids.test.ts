import { expect, test } from 'bun:test';
import { initSearchManager } from '../../../src/api/search.ts';
import { getSearchResultHandler } from '../../../src/protocol/lish-protocol.ts';
import { lishTopic } from '../../../src/protocol/constants.ts';

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

/** A search for a private file's name went out on the public lishnet too, telling it what the member looks for. */
test('a search limited to a protected lishnet asks nothing on the public node', async () => {
	const sent: Array<{ topic: string; searchID: string }> = [];
	const publicNode = { ...node('public-peer', sent), getPeers: (): string[] => ['public-member'], lishScope: null };
	const protectedNode = { ...node('protected-peer', sent), lishScope: 'protected' };
	const dialed: string[] = [];
	(publicNode as any).dialProtocolByPeerId = async (peerID: string) => {
		dialed.push(peerID);
		throw new Error('unreachable');
	};
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
	const manager = initSearchManager(networks as any, { get: () => 30_000 } as any, () => {});
	await manager.startSearch({ query: 'secret plans', networkIDs: ['protected'] });
	await Bun.sleep(20);
	expect(sent.map(s => s.topic)).toEqual([lishTopic('protected')]);
	expect(dialed).toEqual([]);
	manager.stopAll();
});

/** A member using one key on both was looked up by peer ID: the public lishnet came first and the private result went public. */
test('an answer on a protected node stays in its lishnet when the peer is on the public one too', async () => {
	const sent: Array<{ topic: string; searchID: string }> = [];
	const publicNode = { ...node('public-peer', sent), getTopicPeers: (): string[] => ['member'], lishScope: null };
	const protectedNode = { ...node('protected-peer', sent), getTopicPeers: (): string[] => ['member'], lishScope: 'protected' };
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
	const { searchID } = await manager.startSearch({ query: 'shared', networkIDs: ['protected'] });
	const id = sent[0]!.searchID;
	getSearchResultHandler(id, 'protected')?.({ searchID: id, peerID: 'member', lishs: [{ id: LISH_ID, name: 'Shared' }] });
	expect(events.find(e => e.event === 'search:lishs:update')?.data.lishs[0].peers).toEqual([{ peerID: 'member', networkID: 'protected' }]);
	manager.cancelSearch({ searchID });
	manager.stopAll();
});

/** One search ID on the public and a protected lishnet told a member of both that the two identities were one machine. */
test('each node sends a search under its own ID and the answers reach one session', async () => {
	const sent: Array<{ topic: string; searchID: string }> = [];
	const publicNode = node('public-peer', sent);
	const protectedNode = { ...node('protected-peer', sent), lishScope: 'protected' };
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
	// An answer to the protected node's ID arriving on the public node is refused: whoever saw the ID could slip a public
	// offer into a search limited to the protected lishnet.
	expect(getSearchResultHandler(onProtected!.searchID, null)).toBeUndefined();
	// On the protected node it is part of the same search for the UI.
	getSearchResultHandler(onProtected!.searchID, 'protected')?.({ searchID: onProtected!.searchID, peerID: 'member', lishs: [{ id: LISH_ID, name: 'Shared' }] });
	expect(events.find(e => e.event === 'search:lishs:update')?.data.searchID).toBe(searchID);
	manager.cancelSearch({ searchID });
	expect(getSearchResultHandler(onProtected!.searchID, 'protected')).toBeUndefined();
	manager.stopAll();
});
