import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Networks } from '../../../src/lishnet/lishnets.ts';
import { addLISHnet, initLISHnetsTables } from '../../../src/db/lishnets.ts';
import { listPeerCleanup } from '../../../src/db/peer-cleanup.ts';

const peer = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
const bootstrap = `/ip4/192.0.2.1/tcp/9090/p2p/${peer}`;
const row = { networkID: 'network-a', name: 'A', description: '', created: '2026-01-01T00:00:00.000Z', enabled: true, bootstrapPeers: [bootstrap] };

test('catalog reset queues stored bootstrap peers even after the node lost its memberships', () => {
	const db = new Database(':memory:');
	try {
		initLISHnetsTables(db);
		addLISHnet(db, row);
		const networks = new Networks(db, '.', {} as never, {} as never);
		networks.recordPeersForCatalogReset();
		expect(listPeerCleanup(db).map(item => [item.networkID, item.peerID])).toEqual([['network-a', peer]]);
	} finally {
		db.close();
	}
});

test('a bootstrap edit while reconciliation is closed reports stored but not applied', async () => {
	const db = new Database(':memory:');
	try {
		initLISHnetsTables(db);
		addLISHnet(db, row);
		const networks = new Networks(db, '.', {} as never, {} as never);
		const state = networks as any;
		state.joinedNetworks.add(row.networkID);
		state.reconcileAdmissionClosed = true;
		state.appliedBootstrap.set(row.networkID, { addresses: [bootstrap], complete: true });
		const newAddress = bootstrap.replace('192.0.2.1', '192.0.2.2');
		const result = await networks.updateBootstrapPeersDetailed(row.networkID, [newAddress]);
		expect(result.stored).toBe(true);
		expect(result.applied).toBe(false);
		expect(result.transitioned).toBe(false);
		expect(networks.get(row.networkID)?.bootstrapPeers).toEqual([newAddress]);
		expect(state.appliedBootstrap.get(row.networkID).addresses).toEqual([bootstrap]);
	} finally {
		db.close();
	}
});
