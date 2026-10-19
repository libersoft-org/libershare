import { describe, it, expect } from 'bun:test';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';
import { buildLibp2pConfig, type OverlayNodeOptions } from '../../../src/protocol/network-config.ts';

/**
 * The node of a protected lishnet must have no way to learn, verify, open or publish an address outside its
 * overlay; the public node must keep every one of them.
 */

const authorized: Array<[string, string]> = [];
const overlay: OverlayNodeOptions = {
	vpnIP: '100.64.0.5',
	port: 9090,
	bridge: { dialPort: 1, token: 'x'.repeat(40), subnet: '100.64.0.0/16', setInboundPort: async () => {} },
	authorize: async (peerID, overlayIP) => (authorized.push([peerID, overlayIP]), peerID === 'member-ok'),
};

async function build(withOverlay: boolean) {
	const privateKey = await generateKeyPair('Ed25519');
	const settings = { network: { mdnsEnabled: true, mdnsInterval: 10_000, upnpEnabled: true, allowRelay: true, maxRelayReservations: 5, useRelayClients: true, peerExchange: { enabled: true } } } as any;
	return buildLibp2pConfig({ privateKey, datastore: {}, allSettings: settings, bootstrapPeers: [], myPeerID: privateKey.publicKey.toString(), ...(withOverlay ? { overlay } : {}) });
}

describe('buildLibp2pConfig — overlay node', () => {
	it('has the overlay transport only and listens on the overlay address only', async () => {
		const { config, port } = await build(true);
		expect(config.transports).toHaveLength(1);
		expect(config.addresses.listen).toEqual(['/ip4/100.64.0.5/tcp/9090']);
		expect(config.addresses.appendAnnounce).toBeUndefined();
		expect(port).toBe(9090);
	});

	it('runs nothing that learns, verifies or opens a public address', async () => {
		const { config } = await build(true);
		for (const service of ['relay', 'autonat', 'dcutr', 'upnpNAT']) expect(config.services[service]).toBeUndefined();
		expect(config.peerDiscovery ?? []).toHaveLength(0);
	});

	it('announces and dials overlay addresses only', async () => {
		const { config } = await build(true);
		const outside = multiaddr('/ip4/203.0.113.5/tcp/9090');
		const inside = multiaddr('/ip4/100.64.0.9/tcp/9090');
		const lan = multiaddr('/ip4/192.168.99.4/tcp/9090');
		expect(config.addresses.announceFilter([outside, inside, lan]).map((m: any) => m.toString())).toEqual(['/ip4/100.64.0.9/tcp/9090']);
		expect(await config.connectionGater.denyDialMultiaddr(outside)).toBe(true);
		expect(await config.connectionGater.denyDialMultiaddr(lan)).toBe(true);
		expect(await config.connectionGater.denyDialMultiaddr(inside)).toBe(false);
	});
});

describe('buildLibp2pConfig — overlay node identity and names', () => {
	// The libp2p handshake proves a key, not membership: a member could speak under another member's peer ID, and a
	// revoked member with a certificate from another founder device was let in.
	it('lets a connection stand only when the tunnel at its overlay address authorizes its peer ID', async () => {
		const { config } = await build(true);
		const conn = { remoteAddr: multiaddr('/ip4/100.64.0.9/tcp/40000') };
		expect(await config.connectionGater.denyInboundEncryptedConnection({ toString: () => 'member-ok' }, conn)).toBe(false);
		expect(await config.connectionGater.denyOutboundEncryptedConnection({ toString: () => 'someone-else' }, conn)).toBe(true);
		expect(authorized).toEqual([
			['member-ok', '100.64.0.9'],
			['someone-else', '100.64.0.9'],
		]);
	});
});

describe('buildLibp2pConfig — public node unchanged', () => {
	it('keeps TCP, the relay transport, relay server, AutoNAT, DCUtR, UPnP and mDNS', async () => {
		const { config } = await build(false);
		expect(config.transports).toHaveLength(2);
		expect(config.addresses.listen[0]).toMatch(/^\/ip4\/0\.0\.0\.0\/tcp\/\d+$/);
		expect(config.addresses.announceFilter).toBeUndefined();
		for (const service of ['relay', 'autonat', 'dcutr', 'upnpNAT']) expect(config.services[service]).toBeDefined();
		expect(config.peerDiscovery).toHaveLength(1);
	});
});
