import { describe, it, expect, beforeAll } from 'bun:test';
import { multiaddr } from '@multiformats/multiaddr';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { Network } from '../../../src/protocol/network.ts';

/**
 * isBootstrapOrRelayPeer decides which peers lishnet leave may hang up.
 * Exempt: explicitly configured bootstrap peers and relays our circuit
 * connections are routed through. NOT exempt: peer-announce-discovered
 * bootstrap entries and NAT'd peers merely reached via a relay.
 */

let configuredID: string;
let discoveredID: string;
let relayID: string;
let natID: string;

async function newPeerID(): Promise<string> {
	return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

/** Bare Network with only the state isBootstrapOrRelayPeer reads. */
function bareNetwork(conns: Array<{ remoteAddr: ReturnType<typeof multiaddr> }>): Network {
	const net = Object.create(Network.prototype) as any;
	net.configuredBootstrapPeerIDs = new Set([configuredID]);
	net.bootstrapPeerIDs = new Set([configuredID, discoveredID]);
	net.node = { getConnections: () => conns };
	return net as Network;
}

describe('Network.isBootstrapOrRelayPeer — leave disconnect exemptions', () => {
	beforeAll(async () => {
		[configuredID, discoveredID, relayID, natID] = await Promise.all([newPeerID(), newPeerID(), newPeerID(), newPeerID()]);
	});

	it('exempts an explicitly configured bootstrap peer', () => {
		expect(bareNetwork([]).isBootstrapOrRelayPeer(configuredID)).toBe(true);
	});

	it('does NOT exempt a peer-announce-discovered bootstrap entry', () => {
		expect(bareNetwork([]).isBootstrapOrRelayPeer(discoveredID)).toBe(false);
	});

	it('exempts the relay a circuit connection is routed through', () => {
		const circuit = { remoteAddr: multiaddr(`/ip4/198.51.100.7/tcp/4001/p2p/${relayID}/p2p-circuit/p2p/${natID}`) };
		expect(bareNetwork([circuit]).isBootstrapOrRelayPeer(relayID)).toBe(true);
	});

	it('does NOT exempt a NAT peer merely reached via a relay', () => {
		const circuit = { remoteAddr: multiaddr(`/ip4/198.51.100.7/tcp/4001/p2p/${relayID}/p2p-circuit/p2p/${natID}`) };
		expect(bareNetwork([circuit]).isBootstrapOrRelayPeer(natID)).toBe(false);
	});

	it('does NOT exempt a plain directly-connected content peer', () => {
		const direct = { remoteAddr: multiaddr(`/ip4/198.51.100.8/tcp/4001/p2p/${natID}`) };
		expect(bareNetwork([direct]).isBootstrapOrRelayPeer(natID)).toBe(false);
	});
});
