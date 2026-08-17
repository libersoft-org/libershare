import { describe, it, expect } from 'bun:test';
import { Network } from '../../../src/protocol/network.ts';

/**
 * The `peer:discovery` handler. libp2p delivers these events from mDNS, identify and
 * gossipsub PX alike, including for peers this node has already written off — so the
 * handler is a dial path like any other and has to respect the same pacing. It used to
 * respect only leave-network suppression, and it stamped the `keep-alive-fleet` re-dial
 * instruction before making any contact at all.
 */

const PEER_ID = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
const ADDR = { toString: () => `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}` };

type Handler = (evt: any) => void | Promise<void>;

function bareNetwork(opts: { connected?: boolean; dialFails?: boolean } = {}) {
	const dialled: unknown[][] = [];
	const tagged: string[] = [];
	const handlers = new Map<string, Handler>();
	const network = Object.create(Network.prototype) as Network;
	(network as any).runEpoch = 1;
	(network as any).listeners = [];
	(network as any).redialSuppressedByNet = new Map();
	(network as any).redialBackoff = new Map();
	(network as any).unreachableQuarantine = new Map();
	(network as any).dcutrPeers = new Set<string>();
	(network as any).peerDisconnectHandlers = new Set();
	(network as any).bootstrapPeerIDs = new Set<string>();
	(network as any).recentDisconnects = [];
	(network as any).lastMeshChange = new Map();
	(network as any).pubsub = null;
	(network as any).node = {
		peerId: { toString: () => 'selfID' },
		addEventListener(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		getConnections: () => (opts.connected ? [{}] : []),
		getPeers: () => [],
		async dial(multiaddrs: unknown[]): Promise<unknown> {
			dialled.push(multiaddrs);
			if (opts.dialFails) throw new Error('dial timed out');
			return {};
		},
		peerStore: {
			async merge(_pid: unknown, patch: { tags?: Record<string, unknown> }): Promise<void> {
				for (const key of Object.keys(patch.tags ?? {})) tagged.push(key);
			},
		},
	};
	(network as any).setupEventListeners();
	const fire = async (): Promise<void> => {
		await handlers.get('peer:discovery')!({ detail: { id: { toString: () => PEER_ID }, multiaddrs: [ADDR] } });
	};
	return { network, dialled, tagged, fire };
}

describe('peer:discovery — pacing', () => {
	it('dials a peer nothing is holding back', async () => {
		const { dialled, fire } = bareNetwork();
		await fire();
		expect(dialled).toHaveLength(1);
	});

	/**
	 * The eviction path quarantines a peer precisely so it stops being re-dialed. A late
	 * discovery event arriving right after must not undo that.
	 */
	it('refuses to dial a quarantined peer', async () => {
		const { network, dialled, fire } = bareNetwork();
		(network as any).unreachableQuarantine.set(PEER_ID, Date.now());
		await fire();
		expect(dialled).toEqual([]);
	});

	it('refuses to dial a peer inside its redial backoff', async () => {
		const { network, dialled, fire } = bareNetwork();
		(network as any).redialBackoff.set(PEER_ID, { nextAttempt: Date.now() + 60_000, failCount: 2, firstFailure: Date.now(), evictionFails: 0 });
		await fire();
		expect(dialled).toEqual([]);
	});

	it('records a failed discovery dial into the backoff', async () => {
		const { network, fire } = bareNetwork({ dialFails: true });
		await fire();
		expect((network as any).redialBackoff.get(PEER_ID)?.nextAttempt).toBeGreaterThan(Date.now());
	});
});

describe('peer:discovery — keep-alive tagging', () => {
	/**
	 * The tag is a standing instruction to libp2p's ReconnectQueue. Writing it off an
	 * unverified claim is what let an evicted peer get its re-dial instruction back.
	 */
	it('does not tag a peer whose dial failed', async () => {
		const { tagged, fire } = bareNetwork({ dialFails: true });
		await fire();
		expect(tagged).toEqual([]);
	});

	it('does not tag a quarantined peer it never contacted', async () => {
		const { network, tagged, fire } = bareNetwork();
		(network as any).unreachableQuarantine.set(PEER_ID, Date.now());
		await fire();
		expect(tagged).toEqual([]);
	});

	it('tags a peer once the dial succeeds', async () => {
		const { tagged, fire } = bareNetwork();
		await fire();
		expect(tagged).toEqual(['keep-alive-fleet']);
	});

	it('tags a peer we are already connected to, without dialing again', async () => {
		const { dialled, tagged, fire } = bareNetwork({ connected: true });
		await fire();
		expect(tagged).toEqual(['keep-alive-fleet']);
		expect(dialled).toEqual([]);
	});
});
