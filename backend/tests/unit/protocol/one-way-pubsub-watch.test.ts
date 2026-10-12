import { describe, expect, it } from 'bun:test';
import { multiaddr } from '@multiformats/multiaddr';
import { Network } from '../../../src/protocol/network.ts';
import { ONE_WAY_PUBSUB_GRACE_MS, OneWayPubsubWatch } from '../../../src/protocol/one-way-pubsub-watch.ts';

const PEER_A = '12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('OneWayPubsubWatch', () => {
	const oneWay = { outbound: [PEER_A], inbound: [], direct: [PEER_A] };

	it('reports a direct peer that has sent no pubsub stream back for the whole grace period', () => {
		const watch = new OneWayPubsubWatch();
		expect(watch.check(oneWay, 0)).toEqual([]);
		expect(watch.check(oneWay, ONE_WAY_PUBSUB_GRACE_MS - 1)).toEqual([]);
		expect(watch.check(oneWay, ONE_WAY_PUBSUB_GRACE_MS)).toEqual([PEER_A]);
	});

	it('reports it again only after another full period', () => {
		const watch = new OneWayPubsubWatch();
		watch.check(oneWay, 0);
		expect(watch.check(oneWay, ONE_WAY_PUBSUB_GRACE_MS)).toEqual([PEER_A]);
		expect(watch.check(oneWay, ONE_WAY_PUBSUB_GRACE_MS + 30_000)).toEqual([]);
		expect(watch.check(oneWay, 2 * ONE_WAY_PUBSUB_GRACE_MS)).toEqual([PEER_A]);
	});

	it('forgets a peer whose inbound stream came back in between', () => {
		const watch = new OneWayPubsubWatch();
		watch.check(oneWay, 0);
		watch.check({ ...oneWay, inbound: [PEER_A] }, 30_000);
		expect(watch.check(oneWay, ONE_WAY_PUBSUB_GRACE_MS)).toEqual([]);
	});

	it('ignores peers reached only through a relay and peers we hold no stream to', () => {
		const watch = new OneWayPubsubWatch();
		const snapshot = { outbound: [PEER_A], inbound: [], direct: [PEER_B] };
		watch.check(snapshot, 0);
		expect(watch.check(snapshot, ONE_WAY_PUBSUB_GRACE_MS)).toEqual([]);
	});
});

/** A Network carrying only what the status tick's renewal step reads, over a fake node and router. */
function networkWithOneWayPeer(opts: { suppressed?: boolean; peers?: string[]; onDial?: (peerID: string) => void } = {}) {
	const calls: string[] = [];
	const peerIDs = opts.peers ?? [PEER_A];
	const pubsub = { streamsOutbound: new Map<string, unknown>(peerIDs.map(id => [id, {}])), streamsInbound: new Map<string, unknown>() };
	const node = {
		getPeers: () => peerIDs.map(id => ({ toString: () => id })),
		getConnections: () => [{ status: 'open', remoteAddr: multiaddr('/ip4/192.0.2.1/tcp/9090') }],
		hangUp: async (id: { toString(): string }) => void calls.push(`hangUp ${id.toString()}`),
		dial: async (id: { toString(): string }) => {
			calls.push(`dial ${id.toString()}`);
			opts.onDial?.(id.toString());
		},
	};
	const network = Object.create(Network.prototype) as Network;
	(network as any).runEpoch = 1;
	(network as any).node = node;
	(network as any).dialAbort = new AbortController();
	(network as any).oneWayPubsub = new OneWayPubsubWatch();
	(network as any).isRedialSuppressed = () => opts.suppressed === true;
	const tick = (now: number): Promise<void> => (network as any).renewOneWayPubsub(node, pubsub, 1, now);
	return { calls, tick, pubsub };
}

describe('Network — one-way pubsub renewal', () => {
	it('hangs up and redials a connected peer whose pubsub stopped reaching us', async () => {
		const { calls, tick } = networkWithOneWayPeer();
		await tick(0);
		expect(calls).toEqual([]);
		await tick(ONE_WAY_PUBSUB_GRACE_MS);
		expect(calls).toEqual([`hangUp ${PEER_A}`, `dial ${PEER_A}`]);
	});

	it('does not dial back a peer whose network we left', async () => {
		const { calls, tick } = networkWithOneWayPeer({ suppressed: true });
		await tick(0);
		await tick(ONE_WAY_PUBSUB_GRACE_MS);
		expect(calls).toEqual([`hangUp ${PEER_A}`]);
	});

	it('hangs up a late dial to a peer of a left lishnet only when no joined network needs it', async () => {
		const calls: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).node = { hangUp: async (id: { toString(): string }) => void calls.push(id.toString()) };
		(network as any).redialSuppressedByNet = new Map([['left-net', new Set([PEER_A, PEER_B])]]);
		(network as any).isPeerNeededByJoinedNetwork = (peerID: string) => peerID === PEER_B;

		await network.hangUpIfLeft(PEER_A);
		await network.hangUpIfLeft(PEER_B);
		await network.hangUpIfLeft('12D3KooWCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC');

		expect(calls).toEqual([PEER_A]);
	});

	it('leaves alone a second peer whose pubsub came back while the first was being renewed', async () => {
		const setup = networkWithOneWayPeer({
			peers: [PEER_A, PEER_B],
			onDial: id => {
				if (id === PEER_A) setup.pubsub.streamsInbound.set(PEER_B, {});
			},
		});
		await setup.tick(0);
		await setup.tick(ONE_WAY_PUBSUB_GRACE_MS);
		expect(setup.calls).toEqual([`hangUp ${PEER_A}`, `dial ${PEER_A}`]);
	});
});
