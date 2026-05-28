// E2E simulation helper: connects to a running LiberShare backend via WebSocket
// and adds a test network whose bootstrapPeers list contains three intentionally
// crafted entries that exercise every BootstrapPeerStatus state:
//   1. identity-mismatch — valid public address (lish2.libershare.com) wrapped in
//      a wrong /p2p/<id> suffix so the libp2p Noise handshake rejects it
//   2. timeout — a TEST-NET-1 (RFC5737) address with random peerID, guaranteed
//      to time out (documentation address, never routable)
//   3. connected — a real lish1.libershare.com entry with its correct peerID
//
// Usage:
//   bun run scripts/simulate-stale-bootstrap.mjs           # default port 1158
//   BACKEND_PORT=2200 bun run scripts/simulate-stale-bootstrap.mjs

const PORT = process.env.BACKEND_PORT ?? '1158';
const URL = `ws://localhost:${PORT}`;
const TEST_NETWORK_ID = '99999999-0000-4000-8000-stalebootstrap';
const FAKE_PEER_ID = '12D3KooWBADBADBADBADBADBADBADBADBADBADBADBADBADBADxx';
const REAL_LISH1 = '/dns4/lish1.libershare.com/tcp/9090/p2p/12D3KooWAnfqA6Wap96ixVfxhHeGUDMriBG4Nncp5tqu8q71EVv2';
const STALE_LISH2 = `/dns4/lish2.libershare.com/tcp/9090/p2p/${FAKE_PEER_ID}`;
const TIMEOUT_ADDR = '/ip4/192.0.2.1/tcp/9090/p2p/12D3KooWTimeoutTimeoutTimeoutTimeoutTimeoutTime';

let nextId = 1;
const pending = new Map();

const ws = new WebSocket(URL);
await new Promise(r => (ws.onopen = r));

ws.onmessage = ev => {
	const msg = JSON.parse(ev.data);
	if (msg.id != null && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		if (msg.error) reject(new Error(`${msg.error}: ${msg.errorDetail ?? ''}`));
		else resolve(msg.result);
	}
};

function call(method, params) {
	const id = String(nextId++);
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
		setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				reject(new Error(`Timeout waiting for ${method}`));
			}
		}, 15_000);
	});
}

const network = {
	networkID: TEST_NETWORK_ID,
	name: 'STALE-BOOTSTRAP-TEST',
	description: 'Synthetic network with one stale, one unreachable, and one valid bootstrap peer.',
	bootstrapPeers: [STALE_LISH2, TIMEOUT_ADDR, REAL_LISH1],
	created: new Date().toISOString(),
	enabled: true,
};

const exists = await call('lishnets.exists', { networkID: TEST_NETWORK_ID });
if (exists) {
	console.log(`Test network ${TEST_NETWORK_ID} already exists — re-applying bootstrap peers.`);
	await call('lishnets.updateBootstrapPeers', { networkID: TEST_NETWORK_ID, bootstrapPeers: network.bootstrapPeers });
	await call('lishnets.setEnabled', { networkID: TEST_NETWORK_ID, enabled: true });
} else {
	console.log(`Adding test network ${TEST_NETWORK_ID}…`);
	// add only inserts into DB; explicit setEnabled triggers joinNetwork + bootstrap dials.
	await call('lishnets.add', { network: { ...network, enabled: false } });
	await call('lishnets.setEnabled', { networkID: TEST_NETWORK_ID, enabled: true });
}

console.log('Waiting 8s for dial attempts to settle…');
await new Promise(r => setTimeout(r, 8000));

const status = await call('lishnets.getBootstrapStatus', { networkID: TEST_NETWORK_ID });
console.log('Bootstrap status snapshot:');
console.log(JSON.stringify(status, null, 2));

ws.close();
