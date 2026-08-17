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
	(network as any).inFlightDiscoveryDials = new Set<string>();
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

/**
 * leave-network and discovery racing each other. `disconnectPeer` yields twice before it
 * finishes, and a discovery event landing in that window used to read "not suppressed",
 * start a dial, and complete it after the hangUp had already found nothing to close —
 * leaving the peer connected with the leave apparently done.
 */
describe('peer:discovery — a dial that lands after leave-network', () => {
	function racingNetwork(resumeDialInsideLeave = false) {
		const hungUp: string[] = [];
		const tagged: string[] = [];
		const handlers = new Map<string, Handler>();
		let releaseDial: () => void = () => {};
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).listeners = [];
		(network as any).redialSuppressedByNet = new Map();
		(network as any).inFlightDiscoveryDials = new Set<string>();
		(network as any).redialBackoff = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).dcutrPeers = new Set<string>();
		(network as any).peerDisconnectHandlers = new Set();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).recentDisconnects = [];
		(network as any).lastMeshChange = new Map();
		(network as any).pubsub = { getTopics: () => [] };
		(network as any).peerAnnounce = { getRecentMembers: () => [] };
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			addEventListener(event: string, handler: Handler) {
				handlers.set(event, handler);
			},
			getConnections: () => [],
			getPeers: () => [],
			async dial(): Promise<unknown> {
				await new Promise<void>(resolve => {
					releaseDial = resolve;
				});
				return {};
			},
			async hangUp(pid: { toString(): string }): Promise<void> {
				hungUp.push(pid.toString());
			},
			peerStore: {
				async merge(_pid: unknown, patch: { tags?: Record<string, unknown> }): Promise<void> {
					// Only STAMPS count — leave-network merges the same keys with `undefined`
					// to remove them, and that is the opposite of what these tests watch for.
					const removing = Object.values(patch.tags ?? {}).some(value => value === undefined);
					for (const [key, value] of Object.entries(patch.tags ?? {})) if (value !== undefined) tagged.push(key);
					// This merge is disconnectPeer's first await. Letting the parked discovery
					// dial finish HERE is the actual race: the handler resumes before hangUp
					// has run, which is the window the ordering fix has to cover.
					if (removing && resumeDialInsideLeave) {
						releaseDial();
						await Bun.sleep(0);
					}
				},
				async delete(): Promise<void> {},
			},
		};
		(network as any).setupEventListeners();
		const fire = (): Promise<void> => handlers.get('peer:discovery')!({ detail: { id: { toString: () => PEER_ID }, multiaddrs: [ADDR] } }) as Promise<void>;
		return { network, hungUp, tagged, fire, releaseDial: (): void => releaseDial() };
	}

	it('claims the suppression before disconnectPeer yields', async () => {
		const { network } = racingNetwork();
		const leaving = (network as any).disconnectPeer(PEER_ID, 'net-a');
		expect((network as any).redialSuppressedByNet.get('net-a')?.has(PEER_ID)).toBe(true);
		await leaving;
	});

	it('closes a discovery dial that completed after the peer was left', async () => {
		const { network, hungUp, tagged, fire, releaseDial } = racingNetwork();
		const discovering = fire(); // parks inside dial()
		await Bun.sleep(1);
		await (network as any).disconnectPeer(PEER_ID, 'net-a');
		hungUp.length = 0; // the leave's own hangUp found nothing; watch what happens next
		releaseDial();
		await discovering;

		expect(hungUp).toEqual([PEER_ID]);
		expect(tagged).toEqual([]); // and never re-armed the re-dial instruction
	});

	it('keeps a late dial whose peer another joined network still needs', async () => {
		const { network, hungUp, fire, releaseDial } = racingNetwork();
		const discovering = fire();
		await Bun.sleep(1);
		await (network as any).disconnectPeer(PEER_ID, 'net-a');
		(network as any).configuredBootstrapPeerIDs.add(PEER_ID); // infrastructure elsewhere
		hungUp.length = 0;
		releaseDial();
		await discovering;

		expect(hungUp).toEqual([]);
	});

	/**
	 * The interleaving itself: the discovery dial completes DURING `disconnectPeer`, after
	 * the tag removal and before the hangUp. Nothing later in the leave will close that
	 * connection, so the handler has to see the suppression already recorded.
	 */
	it('closes a dial that completes inside the leave, before its hangUp runs', async () => {
		const { network, hungUp, tagged, fire } = racingNetwork(true);
		const discovering = fire();
		await Bun.sleep(1);

		await (network as any).disconnectPeer(PEER_ID, 'net-a');
		await discovering;

		expect(tagged).toEqual([]);
		expect(hungUp).toContain(PEER_ID);
	});
});

/**
 * mDNS, identify and PX all raise a discovery event for the same arrival. The per-peer
 * backoff cannot separate them — it is written only once a dial has already FAILED — so
 * without a claim every event started its own dial of the same identity.
 */
describe('peer:discovery — one dial per peer at a time', () => {
	it('collapses concurrent events for one peer into a single dial', async () => {
		const { network, dialled, fire } = bareNetwork();
		let release!: () => void;
		const gate = new Promise<void>(res => {
			release = res;
		});
		(network as any).node.dial = async (multiaddrs: unknown[]): Promise<unknown> => {
			dialled.push(multiaddrs);
			await gate;
			return {};
		};

		const first = fire();
		const second = fire();
		const third = fire();
		expect(dialled).toHaveLength(1);

		release();
		await Promise.all([first, second, third]);

		// Claim released — a later event is free to dial again.
		await fire();
		expect(dialled).toHaveLength(2);
	});
});

/**
 * The addresses of every discovery event are already in the peerStore by the time this
 * handler runs: libp2p merges each discovery service's list in `#onDiscoveryPeer` and
 * only then dispatches the public `peer:discovery`. A skipped duplicate therefore loses
 * nothing, and an application-level merge would only be an unguarded late write — one
 * that can land after a leave, an eviction or a stop and put back what those removed.
 */
describe('peer:discovery — a skipped duplicate writes nothing of its own', () => {
	const RELAY_ADDR = { toString: () => `/ip4/203.0.113.9/tcp/9090/p2p/RelayXYZ/p2p-circuit/p2p/${PEER_ID}` };
	const DIRECT_ADDR = { toString: () => `/ip4/198.51.100.4/tcp/9090/p2p/${PEER_ID}` };

	it('does not merge addresses of its own while a dial for the peer is in flight', async () => {
		const handlers = new Map<string, Handler>();
		const merged: unknown[][] = [];
		const dialled: unknown[][] = [];
		let releaseDial: () => void = () => {};
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).listeners = [];
		(network as any).redialSuppressedByNet = new Map();
		(network as any).inFlightDiscoveryDials = new Set<string>();
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
			getConnections: () => [],
			getPeers: () => [],
			async dial(multiaddrs: unknown[]): Promise<unknown> {
				dialled.push(multiaddrs);
				await new Promise<void>(resolve => {
					releaseDial = resolve;
				});
				return {};
			},
			peerStore: {
				async merge(_pid: unknown, patch: { multiaddrs?: unknown[] }): Promise<void> {
					if (patch.multiaddrs) merged.push(patch.multiaddrs);
				},
			},
		};
		(network as any).setupEventListeners();
		const fire = async (addr: unknown): Promise<void> => await handlers.get('peer:discovery')!({ detail: { id: { toString: () => PEER_ID }, multiaddrs: [addr] } });

		const first = fire(RELAY_ADDR);
		for (let i = 0; i < 4; i++) await Promise.resolve();
		// Second source names the same peer on a better address while the first dial hangs.
		await fire(DIRECT_ADDR);

		expect(dialled).toHaveLength(1);
		expect(merged).toEqual([]);

		releaseDial();
		await first;
	});
});
