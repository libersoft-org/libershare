import { describe, it, expect } from 'bun:test';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';
import { buildLibp2pConfig } from '../../../src/protocol/network-config.ts';
import { applyGossipsubPXIngressPatch } from '../../../src/protocol/gossipsub-patches.ts';
import { type Settings } from '../../../src/settings.ts';

/**
 * The autodial set and the trust set must not be the same set.
 *
 * `bootstrapPeerIDs` is operational bookkeeping: peer-announce intake and the
 * periodic promotion both write into it, so a peer can enter it purely by
 * announcing itself. `configuredBootstrapPeerIDs` is operator intent. Every
 * security decision — dial-gater bypass, PX trust — must read the second one, or
 * a topic subscriber can talk itself into being treated as operator-chosen.
 */

const CONFIGURED_PEER = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
const DISCOVERED_PEER = '12D3KooWSHj3RRbBueoTHUJnWNfMTLJyRSyxsDcQ9NqPRTBGWZBP';
/** Loopback is refused by the address filter, so only a trust bypass can let it through. */
const LOOPBACK = '/ip4/127.0.0.1/tcp/9090';

/** Minimal settings surface consumed by buildLibp2pConfig / the PX ingress patch. */
function settingsData(): any {
	return {
		network: {
			incomingPort: 0,
			allowRelay: false,
			maxRelayReservations: 0,
			useRelayClients: false,
			maxRelayClients: 0,
			announceAddresses: [],
			mdnsEnabled: false,
			mdnsInterval: 30000,
			upnpEnabled: false,
			peerExchange: { enabled: true, acceptPXThreshold: 5, trustedPeerIds: [], ingressFilterEnabled: true },
		},
	};
}

describe('dial-gater trust boundary', () => {
	it('bypasses the address filter for a configured bootstrap peer', async () => {
		const privateKey = await generateKeyPair('Ed25519');
		const { config } = buildLibp2pConfig({
			privateKey,
			datastore: {},
			allSettings: settingsData(),
			bootstrapPeers: [`${LOOPBACK}/p2p/${CONFIGURED_PEER}`],
			myPeerID: privateKey.publicKey.toString(),
		});

		expect(await config.connectionGater.denyDialMultiaddr(multiaddr(`${LOOPBACK}/p2p/${CONFIGURED_PEER}`))).toBe(false);
	});

	it('does not bypass it for a peer that only reached the autodial set', async () => {
		const privateKey = await generateKeyPair('Ed25519');
		const { config, bootstrapPeerIDs, configuredBootstrapPeerIDs } = buildLibp2pConfig({
			privateKey,
			datastore: {},
			allSettings: settingsData(),
			bootstrapPeers: [`${LOOPBACK}/p2p/${CONFIGURED_PEER}`],
			myPeerID: privateKey.publicKey.toString(),
		});
		// What peer-announce intake and the periodic promotion do: autodial only.
		bootstrapPeerIDs.add(DISCOVERED_PEER);

		expect(configuredBootstrapPeerIDs.has(DISCOVERED_PEER)).toBe(false);
		expect(await config.connectionGater.denyDialMultiaddr(multiaddr(`${LOOPBACK}/p2p/${DISCOVERED_PEER}`))).toBe(true);
	});

	it('trusts the destination of a circuit bootstrap address, not the relay', async () => {
		const privateKey = await generateKeyPair('Ed25519');
		const { configuredBootstrapPeerIDs } = buildLibp2pConfig({
			privateKey,
			datastore: {},
			allSettings: settingsData(),
			bootstrapPeers: [`${LOOPBACK}/p2p/${DISCOVERED_PEER}/p2p-circuit/p2p/${CONFIGURED_PEER}`],
			myPeerID: privateKey.publicKey.toString(),
		});

		expect(configuredBootstrapPeerIDs.has(CONFIGURED_PEER)).toBe(true);
		expect(configuredBootstrapPeerIDs.has(DISCOVERED_PEER)).toBe(false);
	});

	it('drops the bypass again when the peer leaves the configuration', async () => {
		const privateKey = await generateKeyPair('Ed25519');
		const { config, configuredBootstrapPeerIDs } = buildLibp2pConfig({
			privateKey,
			datastore: {},
			allSettings: settingsData(),
			bootstrapPeers: [`${LOOPBACK}/p2p/${CONFIGURED_PEER}`],
			myPeerID: privateKey.publicKey.toString(),
		});
		// Network aliases this set, so pruneConfiguredBootstrapPeer reaches the closure.
		configuredBootstrapPeerIDs.delete(CONFIGURED_PEER);

		expect(await config.connectionGater.denyDialMultiaddr(multiaddr(`${LOOPBACK}/p2p/${CONFIGURED_PEER}`))).toBe(true);
	});
});

/** A PRUNE carrying a PX peer list, as gossipsub hands it to handleReceivedRpc. */
function pruneRpc(): any {
	return { control: { prune: [{ topicID: 'lish/net-a', peers: [{ peerID: 'someone' }] }] } };
}

/** Fake gossipsub exposing only what the PX ingress patch wraps. */
function fakePubsub(): { pubsub: any; seen: any[] } {
	const seen: any[] = [];
	const pubsub: any = {
		handleReceivedRpc: async (_from: any, rpc: any): Promise<void> => {
			seen.push(rpc);
		},
	};
	return { pubsub, seen };
}

describe('PX ingress trust boundary', () => {
	const settings = { list: settingsData } as unknown as Settings;

	it('accepts a PX peer list from a configured bootstrap peer', async () => {
		const { pubsub, seen } = fakePubsub();
		applyGossipsubPXIngressPatch(pubsub, { settings, getConfiguredBootstrapPeerIDs: () => new Set([CONFIGURED_PEER]), pxIngressLogKeys: new Set() });

		await pubsub.handleReceivedRpc({ toString: () => CONFIGURED_PEER }, pruneRpc());

		expect(seen[0].control.prune[0].peers).toHaveLength(1);
	});

	it('strips the PX peer list of a peer that only reached the autodial set', async () => {
		const { pubsub, seen } = fakePubsub();
		// The autodial set holds it; the configured set does not — the only input the
		// filter is allowed to consult.
		applyGossipsubPXIngressPatch(pubsub, { settings, getConfiguredBootstrapPeerIDs: () => new Set([CONFIGURED_PEER]), pxIngressLogKeys: new Set() });

		await pubsub.handleReceivedRpc({ toString: () => DISCOVERED_PEER }, pruneRpc());

		expect(seen[0].control.prune[0].peers).toHaveLength(0);
	});
});
