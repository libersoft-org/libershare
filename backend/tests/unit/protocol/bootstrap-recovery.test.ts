import { describe, it, expect } from 'bun:test';
import { multiaddr } from '@multiformats/multiaddr';
import { Network, bootstrapEntryLastActivity, nextRecoveryBackoff, normalizeMultiaddrForCompare, orderBootstrapEntriesForRecovery, pruneBootstrapEntries, type IBootstrapEntry } from '../../../src/protocol/network.ts';
import { installBootstrapRegistry, registryAddresses, type IRegistrySeed } from '../helpers/bootstrap-registry.ts';

/**
 * The bootstrap registry is what zero-connection recovery walks. It is keyed by the
 * canonical ADDRESS rather than by the peer behind it, because one peer legitimately
 * has several addresses and a user can move a bootstrap to a new host while its
 * identity stays the same — an identity-keyed registry collapsed the first case and
 * treated the second as "already known", so the replaced address went on being dialed.
 *
 * Peer IDs are fake placeholders and addresses use RFC5737 documentation ranges.
 */

const PEER_A = '12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const ADDR_A = `/ip4/192.0.2.1/tcp/9090/p2p/${PEER_A}`;
const ADDR_A2 = `/ip4/192.0.2.2/tcp/9090/p2p/${PEER_A}`;
const ADDR_B = `/ip4/198.51.100.7/tcp/9090/p2p/${PEER_B}`;

const key = (address: string): string => normalizeMultiaddrForCompare(multiaddr(address).toString());

function createTestPeerStore() {
	const records = new Map<string, { addresses: Array<{ multiaddr: any }>; tags: Record<string, unknown> }>();
	const keyOf = (id: { toString(): string }): string => id.toString();
	const asAddresses = (multiaddrs: any[] | undefined): Array<{ multiaddr: any }> => (multiaddrs ?? []).map(ma => ({ multiaddr: ma }));
	return {
		async get(id: { toString(): string }) {
			const record = records.get(keyOf(id));
			if (!record) throw new Error('peer not found');
			return record;
		},
		async merge(id: { toString(): string }, update: { multiaddrs?: any[]; tags?: Record<string, unknown> }): Promise<void> {
			const current = records.get(keyOf(id)) ?? { addresses: [], tags: {} };
			const addresses = update.multiaddrs ? [...new Map([...current.addresses, ...asAddresses(update.multiaddrs)].map(address => [address.multiaddr.toString(), address])).values()] : current.addresses;
			records.set(keyOf(id), { addresses, tags: { ...current.tags, ...update.tags } });
		},
		async patch(id: { toString(): string }, update: { multiaddrs?: any[]; tags?: Record<string, unknown> }): Promise<void> {
			const current = records.get(keyOf(id)) ?? { addresses: [], tags: {} };
			records.set(keyOf(id), {
				addresses: update.multiaddrs ? asAddresses(update.multiaddrs) : current.addresses,
				tags: update.tags ? { ...current.tags, ...update.tags } : current.tags,
			});
		},
		async delete(id: { toString(): string }): Promise<void> {
			records.delete(keyOf(id));
		},
	};
}

/**
 * A Network carrying only the fields the bootstrap paths touch, plus a fake node
 * recording dials. `livePeers` models what `node.getPeers()` reports at the moment the
 * loop runs — deliberately independent of the snapshot the status tick took earlier —
 * and is re-read on every call, so a test can make a connection appear mid-pass.
 */
function bareNetwork(opts: { seeds?: IRegistrySeed[]; suppressed?: string[]; livePeers?: string[]; failDial?: boolean; onDial?: (address: string) => void } = {}) {
	const dialed: string[] = [];
	const livePeers = [...(opts.livePeers ?? [])];
	const handlers = new Map<string, (evt: any) => void | Promise<void>>();
	const network = Object.create(Network.prototype) as Network;
	(network as any).runEpoch = 1;
	(network as any).redialBackoff = new Map();
	(network as any).recoveryBackoff = new Map();
	(network as any).unreachableQuarantine = new Map();
	(network as any).configuredBootstrapPeerIDs = new Set<string>();
	(network as any).bootstrapGeneration = new Map();
	(network as any).redialSuppressedByNet = new Map([['net-x', new Set<string>(opts.suppressed ?? [])]]);
	installBootstrapRegistry(network, opts.seeds ?? []);
	(network as any).bootstrapPeerIDs = new Set([...(network as any).addressesByPeer.keys()]);
	(network as any).recentDisconnects = [];
	(network as any).bootstrapTracker = {
		entries: () => [],
		markPending() {},
		recordOutcome() {},
		recordAddressReachable() {},
		recordAddressUnreachable() {},
		deletePeer() {},
		async batchDebounced(_networkID: string, work: () => Promise<unknown>): Promise<unknown> {
			return work();
		},
	};
	(network as any).node = {
		peerId: { toString: () => 'selfID' },
		addEventListener(event: string, handler: (evt: any) => void | Promise<void>): void {
			handlers.set(event, handler);
		},
		getPeers: () => livePeers.map(p => ({ toString: () => p })),
		getConnections: () => [],
		peerStore: createTestPeerStore(),
		async dial(ma: { toString(): string }): Promise<unknown> {
			dialed.push(ma.toString());
			opts.onDial?.(ma.toString());
			if (opts.failDial) throw new Error('dial failed');
			return { remoteAddr: ma };
		},
	};
	const run = (): Promise<void> => (network as any).runZeroConnectionRecovery([]);
	return { network, dialed, handlers, livePeers, run };
}

describe('bootstrap registry — address identity', () => {
	it('stores a second address of a peer it already knows', async () => {
		// Peer-id dedup used to swallow this: the peer was "already a bootstrap peer",
		// so its other endpoint never entered the list and could never be recovered on.
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }] });
		await (network as any).addBootstrapPeers([ADDR_A2], 'net-a', 'configured');
		expect(registryAddresses(network)).toEqual([key(ADDR_A), key(ADDR_A2)]);
	});

	it('upgrades a discovered entry in place when the user configures that address', async () => {
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, lastVerifiedAt: 1_000 }] });
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		const entry = (network as any).bootstrapByAddress.get(key(ADDR_A)) as IBootstrapEntry;
		expect([...entry.configuredBy]).toEqual(['net-a']);
		// Upgraded, not replaced: the verification it already earned must survive, or the
		// TTL clock silently restarts every time the config is re-applied.
		expect(entry.lastVerifiedAt).not.toBe(null);
		expect(registryAddresses(network)).toEqual([key(ADDR_A)]);
	});
});

/**
 * `bootstrapPeerIDs` is the SAME Set instance handed to buildLibp2pConfig, where the
 * connection gater and the gossipsub PX scoring close over it. An entry there bypasses
 * the routability gate and scores 1000 under PX, so an unverified gossip claim must
 * never put one in — and a failed discovered dial leaves nothing behind that could
 * ever take it out again.
 */
describe('bootstrap trust set — admission', () => {
	it('does not admit a discovered identity that never answered', async () => {
		const { network } = bareNetwork({ failDial: true });
		(network as any).bootstrapPeerIDs = new Set<string>();
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'discovered');
		expect([...((network as any).bootstrapPeerIDs as Set<string>)]).toEqual([]);
	});

	it('admits it once the dial answers', async () => {
		const { network } = bareNetwork();
		(network as any).bootstrapPeerIDs = new Set<string>();
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'discovered');
		expect([...((network as any).bootstrapPeerIDs as Set<string>)]).toEqual([PEER_A]);
	});

	it('admits a configured identity on the strength of the saved config alone', async () => {
		// The user wrote it down; the exemption must apply even while the address is down.
		const { network } = bareNetwork({ failDial: true });
		(network as any).bootstrapPeerIDs = new Set<string>();
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		expect([...((network as any).bootstrapPeerIDs as Set<string>)]).toEqual([PEER_A]);
	});

	it('does not grow the trust set under a flood of failing announces', async () => {
		const { network } = bareNetwork({ failDial: true });
		(network as any).bootstrapPeerIDs = new Set<string>();
		const flood = Array.from({ length: 500 }, (_unused, i) => `/ip4/198.51.100.${(i % 250) + 1}/tcp/${9000 + i}/p2p/${PEER_B}`);
		await (network as any).addBootstrapPeers(flood, 'net-a', 'discovered');
		expect((network as any).bootstrapPeerIDs.size).toBe(0);
	});
});

describe('bootstrap dials — single flight per address', () => {
	it('collapses concurrent announces of one address into a single dial', async () => {
		// peer-announce handlers are fire-and-forget, so overlap is routine: without a
		// claim held for the whole dial, a hundred mentions bought a hundred 10 s dials.
		let release = (): void => {};
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const { network, dialed } = bareNetwork();
		(network as any).node.dial = async (ma: { toString(): string }): Promise<unknown> => {
			dialed.push(ma.toString());
			await gate;
			return { remoteAddr: ma };
		};
		const runs = Promise.all(Array.from({ length: 100 }, () => (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'discovered')));
		// Every handler has now reached the claim; only one may be past it.
		expect(dialed.length).toBe(1);
		release();
		await runs;
		expect(dialed.length).toBe(1);
	});

	it('paces a later failed announce and retries it after the backoff expires', async () => {
		const { network, dialed } = bareNetwork({ failDial: true });
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'discovered');
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'discovered');
		expect(dialed.length).toBe(1);
		(network as any).recoveryBackoff.set(key(ADDR_A), { nextAttempt: Date.now() - 1, failCount: 1 });
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'discovered');
		expect(dialed.length).toBe(2);
	});

	it('lets a sibling address of the same peer dial in parallel', async () => {
		// Keyed by endpoint, not identity: two addresses are two different questions.
		let release = (): void => {};
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const { network, dialed } = bareNetwork();
		(network as any).node.dial = async (ma: { toString(): string }): Promise<unknown> => {
			dialed.push(ma.toString());
			await gate;
			return { remoteAddr: ma };
		};
		const runs = Promise.all([(network as any).addBootstrapPeers([ADDR_A], 'net-a', 'discovered'), (network as any).addBootstrapPeers([ADDR_A2], 'net-a', 'discovered')]);
		expect(dialed.length).toBe(2);
		release();
		await runs;
	});
});

/**
 * An expired unreachable-quarantine buys exactly ONE probe. The old code deleted the
 * quarantine synchronously and only then awaited the dial, so every concurrent handler
 * that arrived afterwards saw a clean peer and spent another dial — and only the first
 * carried the flag that re-closes the window on failure. Announce handlers are
 * fire-and-forget, so the overlap is the normal case, not the exotic one.
 */
describe('bootstrap dials — one probe per expired quarantine', () => {
	/** Older than UNREACHABLE_QUARANTINE_MS by any margin — the window has lapsed. */
	const EXPIRED = Date.now() - 24 * 60 * 60 * 1000;

	function quarantined(opts: { failDial?: boolean } = {}) {
		const harness = bareNetwork(opts.failDial === undefined ? {} : { failDial: opts.failDial });
		(harness.network as any).unreachableQuarantine = new Map([[PEER_A, EXPIRED]]);
		return harness;
	}

	it('spends exactly one dial across concurrent announces of different addresses', async () => {
		// Different addresses on purpose: the address-level single flight cannot collapse
		// these, so only the peer-level probe reservation can.
		const { network, dialed } = quarantined();
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		(network as any).node.dial = async (ma: { toString(): string }): Promise<unknown> => {
			dialed.push(ma.toString());
			await gate;
			return { remoteAddr: ma };
		};
		const runs = Promise.all([(network as any).addBootstrapPeers([ADDR_A], 'net-a', 'discovered'), (network as any).addBootstrapPeers([ADDR_A2], 'net-a', 'discovered')]);
		expect(dialed.length).toBe(1);
		release();
		await runs;
		expect(dialed.length).toBe(1);
	});

	it('re-closes the window when the one probe fails', async () => {
		const { network, dialed } = quarantined({ failDial: true });
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'discovered');
		expect(dialed.length).toBe(1);
		expect((network as any).unreachableQuarantine.has(PEER_A)).toBe(true);
		// A later mention now finds a fresh window and buys nothing.
		dialed.length = 0;
		await (network as any).addBootstrapPeers([ADDR_A2], 'net-a', 'discovered');
		expect(dialed).toEqual([]);
	});

	it('releases the reservation so a later expiry buys its own probe', async () => {
		const { network } = quarantined({ failDial: true });
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'discovered');
		expect((network as any).quarantineProbeInFlight.size).toBe(0);
	});

	it('hands the window back untouched when the address is already in flight', async () => {
		// Refusing a duplicate must not spend the probe, and must not restamp the
		// quarantine either — restamping would silently extend it on every mention.
		const { network, dialed } = quarantined();
		// Another run already holds the ADDRESS lock — reached here without a quarantine,
		// so the peer reservation is free. This run therefore passes the peer check and
		// consumes the window, then finds the address in flight and must hand the window
		// back with its ORIGINAL timestamp: a refused probe was never spent.
		(network as any).inFlightBootstrapDials = new Map([[key(ADDR_A), { networkID: 'net-a', generation: 0, settled: new Promise<void>(() => {}), release: (): void => {} }]]);
		const refused = (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'discovered');
		expect((network as any).unreachableQuarantine.get(PEER_A)).toBe(EXPIRED);
		expect((network as any).quarantineProbeInFlight.has(PEER_A)).toBe(false);
		await refused;
		expect(dialed.length).toBe(0);
	});

	it('re-arms the window when a failing probe is superseded mid-dial', async () => {
		const { network } = quarantined();
		(network as any).node.dial = async (): Promise<never> => {
			(network as any).bootstrapGeneration.set('net-a', 1);
			throw new Error('dial failed after config changed');
		};
		const result = await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'discovered');
		expect(result).toBe('incomplete');
		expect((network as any).unreachableQuarantine.get(PEER_A)).toBeGreaterThan(EXPIRED);
		expect((network as any).quarantineProbeInFlight.has(PEER_A)).toBe(false);
	});
});

describe('bootstrap registry — per-network ownership', () => {
	it('keeps an address one network drops while another still configures it', () => {
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a', 'net-b'] }] });
		network.pruneBootstrapAddresses([ADDR_A], 'net-a');
		expect(registryAddresses(network)).toEqual([key(ADDR_A)]);
		expect([...((network as any).bootstrapByAddress.get(key(ADDR_A)) as IBootstrapEntry).configuredBy]).toEqual(['net-b']);
	});

	it('removes it once the last network drops it', () => {
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a', 'net-b'] }] });
		network.pruneBootstrapAddresses([ADDR_A], 'net-a');
		network.pruneBootstrapAddresses([ADDR_A], 'net-b');
		expect(registryAddresses(network)).toEqual([]);
	});

	it('keeps an independently discovered claim after its configured owner is removed', () => {
		const { network } = bareNetwork({
			seeds: [{ address: ADDR_A, configuredBy: ['net-a'], discovered: true, lastVerifiedAt: Date.now() }],
		});
		network.pruneBootstrapAddresses([ADDR_A], 'net-a');
		const entry = (network as any).bootstrapByAddress.get(key(ADDR_A)) as IBootstrapEntry;
		expect(entry.discovered).toBe(true);
		expect(entry.configuredBy.size).toBe(0);
	});

	it('never recovery-dials a removed configured address again', async () => {
		const { network, dialed, run } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }] });
		network.pruneBootstrapAddresses([ADDR_A], 'net-a');
		await run();
		expect(dialed).toEqual([]);
	});

	it('leaves a purely discovered entry alone when an unrelated config edit lands', () => {
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }, { address: ADDR_B }] });
		network.pruneConfiguredBootstrapPeer(PEER_A, 'net-a');
		expect(registryAddresses(network)).toEqual([key(ADDR_B)]);
	});
});

describe('bootstrap registry — identity mismatch', () => {
	const MISMATCH = `Payload identity key ${PEER_B} does not match expected remote identity key ${PEER_A}`;

	it('parks a disproved configured address without losing its saved ownership', async () => {
		const { network } = bareNetwork({
			seeds: [
				{ address: ADDR_A, configuredBy: ['net-a'] },
				{ address: ADDR_A2, configuredBy: ['net-a'] },
			],
		});
		(network as any).purgeStalePeer = async () => 'purged' as const;
		(network as any).node.dial = async (): Promise<never> => {
			throw new Error(MISMATCH);
		};
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		const disproved = (network as any).bootstrapByAddress.get(key(ADDR_A)) as IBootstrapEntry;
		expect(disproved.disproved).toBe(true);
		expect([...disproved.configuredBy]).toEqual(['net-a']);
		expect((network as any).configuredBootstrapAddressesByNet.get('net-a').has(key(ADDR_A))).toBe(true);
		// The sibling was never tested and remains usable.
		expect(registryAddresses(network)).toEqual([key(ADDR_A), key(ADDR_A2)]);
	});

	it('keeps a configured address that lives only in the registry', async () => {
		// The configured entry models a LAN or VPN bootstrap parked while its interface
		// is down: it is in the registry and NOT in the peerStore. A topic subscriber
		// announces a second address of the same peer, which Noise disproves. Counting
		// survivors from the peerStore alone read zero and purged the whole peer —
		// taking the configured address nothing had disproved with it.
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }, { address: ADDR_A2 }] });
		const purged: string[] = [];
		(network as any).purgeStalePeer = async (peerID: string) => {
			purged.push(peerID);
			return 'purged' as const;
		};
		(network as any).node.dial = async (): Promise<never> => {
			throw new Error(MISMATCH);
		};
		await (network as any).addBootstrapPeers([ADDR_A2], 'net-a', 'discovered');
		expect(purged).toEqual([]);
		expect(registryAddresses(network)).toEqual([key(ADDR_A)]);
	});

	it('still purges once nothing undisproved is left anywhere', async () => {
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }] });
		const purged: string[] = [];
		(network as any).purgeStalePeer = async (peerID: string) => {
			purged.push(peerID);
			return 'purged' as const;
		};
		(network as any).node.dial = async (): Promise<never> => {
			throw new Error(MISMATCH);
		};
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		expect(purged).toEqual([PEER_A]);
	});

	it('stops recovery dialing a disproved CONFIGURED address', async () => {
		const { network, dialed } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }] });
		(network as any).purgeStalePeer = async () => 'purged' as const;
		(network as any).node.dial = async (): Promise<never> => {
			throw new Error(MISMATCH);
		};
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		dialed.length = 0;
		await (network as any).runZeroConnectionRecovery([]);
		expect(dialed).toEqual([]);
	});

	it('does not let later gossip turn the configured mismatch green through a sibling endpoint', async () => {
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }] });
		const outcomes: Array<{ status: string; origin: string }> = [];
		(network as any).bootstrapTracker.recordOutcome = (_networkID: string, _address: string, _peerID: string | null, status: string, _message: string | null, _actualPeerID: string | null, origin: string): void => {
			outcomes.push({ status, origin });
		};
		let first = true;
		(network as any).node.dial = async (): Promise<unknown> => {
			if (first) {
				first = false;
				throw new Error(MISMATCH);
			}
			return { remoteAddr: multiaddr(ADDR_A2) };
		};

		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		(network as any).recoveryBackoff.delete(key(ADDR_A));
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'discovered');

		expect(outcomes).toEqual([{ status: 'identity-mismatch', origin: 'configured' }]);
	});

	it('re-probes when another peer is connected on the disproved endpoint', async () => {
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }] });
		const reachable: string[] = [];
		const outcomes: string[] = [];
		let dials = 0;
		(network as any).purgeStalePeer = async () => 'purged' as const;
		(network as any).bootstrapTracker.recordAddressReachable = (address: string): void => {
			reachable.push(address);
		};
		(network as any).bootstrapTracker.recordOutcome = (_networkID: string, _address: string, _peerID: string | null, status: string): void => {
			outcomes.push(status);
		};
		(network as any).node.getConnections = () =>
			dials === 0
				? []
				: [
						{
							remoteAddr: multiaddr(`/ip4/192.0.2.1/tcp/9090/p2p/${PEER_B}`),
							remotePeer: { toString: () => PEER_B },
						},
					];
		(network as any).node.dial = async (): Promise<never> => {
			dials++;
			throw new Error(MISMATCH);
		};

		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		(network as any).recoveryBackoff.delete(key(ADDR_A));
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'discovered');

		expect(dials).toBe(2);
		expect(reachable).toEqual([]);
		expect(outcomes).toEqual(['identity-mismatch', 'identity-mismatch']);
		expect(((network as any).bootstrapByAddress.get(key(ADDR_A)) as IBootstrapEntry).disproved).toBe(true);
	});

	it('re-probes a disproved endpoint even when an older connection has the expected peer', async () => {
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }] });
		const reachable: string[] = [];
		let dials = 0;
		(network as any).purgeStalePeer = async () => 'purged' as const;
		(network as any).bootstrapTracker.recordAddressReachable = (address: string): void => {
			reachable.push(address);
		};
		(network as any).node.getConnections = () =>
			dials === 0
				? []
				: [
						{
							remoteAddr: multiaddr(ADDR_A),
							remotePeer: { toString: () => PEER_A },
						},
					];
		(network as any).node.dial = async (): Promise<never> => {
			dials++;
			throw new Error(MISMATCH);
		};

		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		(network as any).recoveryBackoff.delete(key(ADDR_A));
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'discovered');

		expect(dials).toBe(2);
		expect(reachable).toEqual([]);
	});

	it('reports a mismatch learned elsewhere to every network that configures the address', async () => {
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }] });
		const outcomes: Array<{ networkID: string; status: string; origin: string }> = [];
		(network as any).bootstrapTracker.recordOutcome = (networkID: string, _address: string, _peerID: string | null, status: string, _message: string | null, _actualPeerID: string | null, origin: string): void => {
			outcomes.push({ networkID, status, origin });
		};
		(network as any).node.dial = async (): Promise<never> => {
			throw new Error(MISMATCH);
		};

		await (network as any).addBootstrapPeers([ADDR_A], 'net-b', 'discovered');

		expect(outcomes).toEqual([
			{ networkID: 'net-b', status: 'identity-mismatch', origin: 'discovered' },
			{ networkID: 'net-a', status: 'identity-mismatch', origin: 'configured' },
		]);
	});
});

describe('Network.runZeroConnectionRecovery — per-address pacing', () => {
	it('paces the address that failed, not its working sibling', async () => {
		const { network, dialed, run } = bareNetwork({ seeds: [{ address: ADDR_A }, { address: ADDR_A2 }], failDial: true });
		(network as any).recoveryBackoff.set(key(ADDR_A), { nextAttempt: Date.now() + 60_000, failCount: 1 });
		await run();
		expect(dialed).toEqual([multiaddr(ADDR_A2).toString()]);
	});

	it('records an address backoff after a failed dial so the next pass skips it', async () => {
		const { network, dialed, run } = bareNetwork({ seeds: [{ address: ADDR_A }], failDial: true });
		await run();
		expect(dialed.length).toBe(1);
		const backoff = (network as any).recoveryBackoff.get(key(ADDR_A));
		expect(backoff.failCount).toBe(1);
		expect(backoff.nextAttempt).toBeGreaterThan(Date.now());
		dialed.length = 0;
		await run();
		expect(dialed).toEqual([]);
	});

	it('writes nothing when a stop lands while the successful dial is in flight', async () => {
		// The failure branch was fenced, the success branch was not. Canonical keys are
		// stable across runs, so the old run's result landed on the new run's entry.
		let net: any;
		const { network, run } = bareNetwork({
			seeds: [{ address: ADDR_A }],
			onDial: () => {
				net.runEpoch = 2;
			},
		});
		net = network;
		await run();
		expect(((network as any).bootstrapByAddress.get(key(ADDR_A)) as IBootstrapEntry).lastVerifiedAt).toBe(null);
	});

	it('does not mark an address verified when a sibling endpoint answered', async () => {
		// libp2p coalesces dials of one peer ID, so a resolved dial is not proof about
		// the address it was asked for — addBootstrapPeers reads the result for exactly
		// that reason, recovery did not and turned a dead endpoint green.
		const { network, run } = bareNetwork({ seeds: [{ address: ADDR_A }] });
		(network as any).node.dial = async (): Promise<unknown> => ({ remoteAddr: multiaddr(ADDR_A2) });
		await run();
		expect(((network as any).bootstrapByAddress.get(key(ADDR_A)) as IBootstrapEntry).lastVerifiedAt).toBe(null);
	});

	it('clears the address backoff after a successful dial', async () => {
		const { network, run } = bareNetwork({ seeds: [{ address: ADDR_A }] });
		(network as any).recoveryBackoff.set(key(ADDR_A), { nextAttempt: Date.now() - 1, failCount: 3 });
		await run();
		expect((network as any).recoveryBackoff.has(key(ADDR_A))).toBe(false);
	});
});

describe('Network.runZeroConnectionRecovery — registry walk', () => {
	it('dials configured entries before gossip-discovered ones', async () => {
		// The discovered entry is seeded first, so plain insertion order would dial it first.
		const { dialed, run } = bareNetwork({ seeds: [{ address: ADDR_B }, { address: ADDR_A, configuredBy: ['net-a'] }], failDial: true });
		await run();
		expect(dialed).toEqual([multiaddr(ADDR_A).toString(), multiaddr(ADDR_B).toString()]);
	});

	it('still skips a peer suppressed by leave-network', async () => {
		const { dialed, run } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }], suppressed: [PEER_A] });
		await run();
		expect(dialed).toEqual([]);
	});
});

describe('Network.runZeroConnectionRecovery — liveness and budget', () => {
	/** Distinct dead addresses of one peer, enough to overrun the per-pass budget. */
	const deadAddresses = (count: number): IRegistrySeed[] => Array.from({ length: count }, (_unused, i) => ({ address: `/ip4/192.0.2.${i + 10}/tcp/9090/p2p/${PEER_A}` }));

	it('does not run at all when a live connection exists despite a stale zero snapshot', async () => {
		// The status tick snapshots connected peers BEFORE re-dial maintenance; that pass
		// can connect a peer, making the snapshot a zero that is no longer true.
		const { dialed, run } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }], livePeers: [PEER_B] });
		await run();
		expect(dialed).toEqual([]);
	});

	it('runs when the old snapshot still names a peer that has since disconnected', async () => {
		const { network, dialed } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }] });
		await (network as any).runZeroConnectionRecovery([PEER_B], 1);
		expect(dialed).toEqual([multiaddr(ADDR_A).toString()]);
	});

	it('stops mid-pass as soon as a connection appears', async () => {
		// An inbound connection lands while the pass is between dials. Continuing would
		// keep hammering bootstrap addresses for a node that is no longer isolated.
		const holder: { livePeers: string[]; dialed: string[]; run: () => Promise<void> } = bareNetwork({
			seeds: deadAddresses(5),
			failDial: true,
			onDial: () => {
				holder.livePeers.push(PEER_B);
			},
		});
		await holder.run();
		expect(holder.dialed.length).toBe(1);
	});

	it('honours its per-pass attempt budget', async () => {
		// 20 dead addresses at 10 s apiece would occupy the status tick for minutes.
		const { dialed, run } = bareNetwork({ seeds: deadAddresses(20), failDial: true });
		await run();
		expect(dialed.length).toBe(8);
	});

	it('does not dial an entry removed while the previous dial was settling', async () => {
		let network!: Network;
		const holder = bareNetwork({
			seeds: [
				{ address: ADDR_A, configuredBy: ['net-a'] },
				{ address: ADDR_B, configuredBy: ['net-b'] },
			],
			failDial: true,
			onDial: address => {
				if (address === multiaddr(ADDR_A).toString()) network.pruneBootstrapAddresses([ADDR_B], 'net-b');
			},
		});
		network = holder.network;
		await holder.run();
		expect(holder.dialed).toEqual([multiaddr(ADDR_A).toString()]);
	});

	it('does not recreate backoff for an address removed during its failed dial', async () => {
		let network!: Network;
		const holder = bareNetwork({
			seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }],
			failDial: true,
			onDial: () => network.pruneBootstrapAddresses([ADDR_A], 'net-a'),
		});
		network = holder.network;
		await holder.run();
		expect((network as any).recoveryBackoff.has(key(ADDR_A))).toBe(false);
	});

	it('keeps a sibling connection still owned by another network after removal mid-dial', async () => {
		const { network, run } = bareNetwork({
			seeds: [
				{ address: ADDR_A, configuredBy: ['net-a'] },
				{ address: ADDR_A2, configuredBy: ['net-b'] },
			],
		});
		let closed = 0;
		(network as any).node.dial = async (): Promise<unknown> => {
			network.pruneBootstrapAddresses([ADDR_A], 'net-a');
			return { remoteAddr: multiaddr(ADDR_A2), close: async (): Promise<void> => void closed++ };
		};

		await run();

		expect(closed).toBe(0);
		expect(registryAddresses(network)).toEqual([key(ADDR_A2)]);
	});

	it('closes only the stale connection when a restart replaces the node mid-dial', async () => {
		const { network, run } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }] });
		const oldNode = (network as any).node;
		let closed = 0;
		let newNodeHangUps = 0;
		oldNode.dial = async (): Promise<unknown> => {
			(network as any).runEpoch = 2;
			(network as any).node = {
				hangUp: async (): Promise<void> => void newNodeHangUps++,
			};
			return { remoteAddr: multiaddr(ADDR_A), close: async (): Promise<void> => void closed++ };
		};

		await run();

		expect(closed).toBe(1);
		expect(newNodeHangUps).toBe(0);
	});

	it('reserves one budget slot for a discovered address behind nine configured entries', async () => {
		const configured = deadAddresses(9).map(seed => ({ ...seed, configuredBy: ['net-a'] }));
		const { dialed, run } = bareNetwork({ seeds: [...configured, { address: ADDR_B }], failDial: true });
		await run();
		expect(dialed).toHaveLength(8);
		expect(dialed.slice(0, 7)).toEqual(configured.slice(0, 7).map(seed => multiaddr(seed.address).toString()));
		expect(dialed[7]).toBe(multiaddr(ADDR_B).toString());
	});

	/**
	 * Eight timeouts take up to 80 s, by which time the 30 s backoff of the first eight
	 * has expired again. Rebuilding the same order every pass therefore replayed the
	 * same prefix indefinitely and never reached the tail at all.
	 */
	it('resumes the next pass where the previous one ran out of budget', async () => {
		const seeds = deadAddresses(16);
		const { network, dialed, run } = bareNetwork({ seeds, failDial: true });
		await run();
		const first = [...dialed];
		expect(first.length).toBe(8);
		// Clearing the backoff is the point of the test, not a shortcut around it: eight
		// timeouts take up to 80 s and the backoff starts at 30 s, so by the time a pass
		// ends its own pacing has expired. With the backoff gone, ONLY the cursor can
		// keep the second pass off the addresses the first one already tried.
		(network as any).recoveryBackoff.clear();
		dialed.length = 0;
		await run();
		expect(dialed.length).toBe(8);
		expect(dialed[0]).toBe(multiaddr(seeds[8]!.address).toString());
		// Between them the two passes covered every address exactly once.
		expect(new Set([...first, ...dialed]).size).toBe(16);
	});

	it('wraps back to the front once the tail has been covered', async () => {
		const seeds = deadAddresses(12);
		const { network, dialed, run } = bareNetwork({ seeds, failDial: true });
		await run();
		(network as any).recoveryBackoff.clear();
		dialed.length = 0;
		await run();
		// 12 entries, 8 per pass: the second pass takes the last four then wraps.
		expect(dialed[0]).toBe(multiaddr(seeds[8]!.address).toString());
		expect(dialed[4]).toBe(multiaddr(seeds[0]!.address).toString());
	});
});

/**
 * The startup workaround is a one-shot timer scheduled two seconds into a run. It used
 * to store no handle, be cleared by nothing, and re-read `this.node` in its callback —
 * so after a fast stop/start the old run's timer dialed on the new node's behalf,
 * alongside the fresh timer that instance had scheduled for itself.
 */
describe('Network.runBootstrapWorkaround — lifecycle fence', () => {
	const run = (network: Network, node: unknown, epoch: number): Promise<void> => (network as any).runBootstrapWorkaround(node, epoch);

	it('dials the registry when the run it belongs to is still current', async () => {
		const { network, dialed } = bareNetwork({ seeds: [{ address: ADDR_A }], failDial: true });
		await run(network, (network as any).node, 1);
		expect(dialed).toEqual([multiaddr(ADDR_A).toString()]);
	});

	it('does nothing once the epoch has moved on', async () => {
		const { network, dialed } = bareNetwork({ seeds: [{ address: ADDR_A }], failDial: true });
		await run(network, (network as any).node, 0);
		expect(dialed).toEqual([]);
	});

	it('does nothing when the node it captured is no longer the current one', async () => {
		const { network, dialed } = bareNetwork({ seeds: [{ address: ADDR_A }], failDial: true });
		await run(network, { getPeers: () => [], async dial(): Promise<void> {} }, 1);
		expect(dialed).toEqual([]);
	});

	it('stops walking the registry when a stop lands mid-pass', async () => {
		let net: any;
		const { network, dialed } = bareNetwork({
			seeds: [{ address: ADDR_A }, { address: ADDR_A2 }],
			failDial: true,
			onDial: () => {
				net.runEpoch = 2;
			},
		});
		net = network;
		await run(network, (network as any).node, 1);
		expect(dialed.length).toBe(1);
	});

	it('uses the recovery backoff instead of redialing immediately', async () => {
		const { network, dialed } = bareNetwork({ seeds: [{ address: ADDR_A }], failDial: true });
		(network as any).recoveryBackoff.set(key(ADDR_A), { nextAttempt: Date.now() + 60_000, failCount: 1 });
		await run(network, (network as any).node, 1);
		expect(dialed).toEqual([]);
	});

	it('uses the same bounded dial budget as periodic recovery', async () => {
		const seeds = Array.from({ length: 20 }, (_unused, i) => ({ address: `/ip4/192.0.2.${i + 10}/tcp/9090/p2p/${PEER_A}` }));
		const { network, dialed } = bareNetwork({ seeds, failDial: true });
		await run(network, (network as any).node, 1);
		expect(dialed).toHaveLength(8);
	});
});

describe('bootstrap registry — live size bound', () => {
	it('enforces the discovered-entry cap as addresses are remembered', () => {
		const { network } = bareNetwork();
		const addresses = Array.from({ length: 201 }, (_unused, i) => `/ip4/198.51.100.1/tcp/${9000 + i}/p2p/${PEER_A}`);
		for (const address of addresses) (network as any).rememberBootstrapAddress(multiaddr(address));
		expect((network as any).bootstrapByAddress.size).toBe(200);
	});
});

describe('bootstrap registry — disconnect activity', () => {
	it('refreshes only the endpoint whose connection closed', () => {
		const { network, handlers } = bareNetwork({
			seeds: [
				{ address: ADDR_A, lastVerifiedAt: 1 },
				{ address: ADDR_A2, lastVerifiedAt: 1 },
			],
		});
		(network as any).listeners = [];
		(network as any).dcutrPeers = new Set<string>();
		(network as any).peerDisconnectHandlers = new Set();
		(network as any).lastMeshChange = new Map();
		(network as any).pubsub = null;
		(network as any).setupEventListeners();

		handlers.get('connection:close')!({
			detail: { remoteAddr: multiaddr(ADDR_A), remotePeer: { toString: () => PEER_A } },
		});
		handlers.get('peer:disconnect')!({ detail: { toString: () => PEER_A } });

		const first = (network as any).bootstrapByAddress.get(key(ADDR_A)) as IBootstrapEntry;
		const sibling = (network as any).bootstrapByAddress.get(key(ADDR_A2)) as IBootstrapEntry;
		expect(first.lastDisconnectedAt).toBeNumber();
		expect(sibling.lastDisconnectedAt).toBe(null);
	});
});

describe('bootstrapEntryLastActivity', () => {
	const base = { firstSeenAt: 100, lastVerifiedAt: null, lastDisconnectedAt: null };

	it('falls back to the insertion time while nothing else has happened', () => {
		expect(bootstrapEntryLastActivity(base)).toBe(100);
	});

	it('prefers a later verification', () => {
		expect(bootstrapEntryLastActivity({ ...base, lastVerifiedAt: 500 })).toBe(500);
	});

	it('counts a disconnect as activity too', () => {
		expect(bootstrapEntryLastActivity({ ...base, lastVerifiedAt: 500, lastDisconnectedAt: 900 })).toBe(900);
	});
});

describe('pruneBootstrapEntries', () => {
	const now = 1_000_000_000;

	const discovered = (overrides: Partial<Pick<IBootstrapEntry, 'firstSeenAt' | 'lastVerifiedAt' | 'lastDisconnectedAt' | 'peerID'>> = {}) => ({
		firstSeenAt: now,
		lastVerifiedAt: null,
		lastDisconnectedAt: null,
		peerID: null,
		configuredBy: new Set<string>(),
		...overrides,
	});

	it('keeps discovered entries inside the TTL', () => {
		const entries = [discovered({ firstSeenAt: now - 10 })];
		expect(pruneBootstrapEntries(entries, now, 100, 10)).toEqual(entries);
	});

	it('drops discovered entries past the TTL', () => {
		expect(pruneBootstrapEntries([discovered({ firstSeenAt: now - 101 })], now, 100, 10)).toEqual([]);
	});

	/**
	 * The TTL used to run from insertion. A bootstrap that answered ten hours ago and
	 * has been serving us ever since would lose its registry entry while it was at its
	 * most useful, leaving nothing to dial the moment the connection dropped.
	 */
	it('measures the TTL from the last verification, not from first insert', () => {
		const verified = discovered({ firstSeenAt: now - 10_000, lastVerifiedAt: now - 10 });
		expect(pruneBootstrapEntries([verified], now, 100, 10)).toEqual([verified]);
	});

	it('measures it from the last disconnect too', () => {
		const dropped = discovered({ firstSeenAt: now - 10_000, lastVerifiedAt: now - 9_000, lastDisconnectedAt: now - 10 });
		expect(pruneBootstrapEntries([dropped], now, 100, 10)).toEqual([dropped]);
	});

	it('expires an entry whose last verification is itself past the TTL', () => {
		expect(pruneBootstrapEntries([discovered({ firstSeenAt: now - 10_000, lastVerifiedAt: now - 101 })], now, 100, 10)).toEqual([]);
	});

	it('keeps configured entries past the TTL', () => {
		const entries = [{ ...discovered({ firstSeenAt: now - 10_000 }), configuredBy: new Set(['net-a']) }];
		expect(pruneBootstrapEntries(entries, now, 100, 10)).toEqual(entries);
	});

	it('caps discovered entries at the bound, keeping the newest', () => {
		const entries = [
			{ ...discovered({ firstSeenAt: now - 3 }), tag: 'oldest' },
			{ ...discovered({ firstSeenAt: now - 2 }), tag: 'mid' },
			{ ...discovered({ firstSeenAt: now - 1 }), tag: 'newest' },
		];
		expect(pruneBootstrapEntries(entries, now, 100, 2).map(e => e.tag)).toEqual(['mid', 'newest']);
	});

	/**
	 * The cap used to drop in insertion order while the TTL measured from last activity.
	 * A peer known for hours that JUST disconnected — precisely when its recovery address
	 * is needed — was therefore evicted ahead of a newer entry nothing had touched.
	 */
	it('caps by last activity, not by when the entry was inserted', () => {
		const entries = [
			{ ...discovered({ firstSeenAt: now - 10, lastDisconnectedAt: now - 1 }), tag: 'old-but-just-dropped' },
			{ ...discovered({ firstSeenAt: now - 9, lastVerifiedAt: now - 2 }), tag: 'old-but-just-verified' },
			{ ...discovered({ firstSeenAt: now - 8 }), tag: 'newer-but-idle' },
		];
		expect(pruneBootstrapEntries(entries, now, 100, 2).map(e => e.tag)).toEqual(['old-but-just-dropped', 'old-but-just-verified']);
	});

	it('breaks ties on activity by position so the result is stable', () => {
		const entries = [
			{ ...discovered({ firstSeenAt: now - 5 }), tag: 'a' },
			{ ...discovered({ firstSeenAt: now - 5 }), tag: 'b' },
			{ ...discovered({ firstSeenAt: now - 5 }), tag: 'c' },
		];
		expect(pruneBootstrapEntries(entries, now, 100, 2).map(e => e.tag)).toEqual(['b', 'c']);
	});

	it('does not count configured entries against the bound nor drop them', () => {
		const entries = [
			{ ...discovered({ firstSeenAt: now - 9 }), configuredBy: new Set(['net-a']), tag: 'cfg1' },
			{ ...discovered({ firstSeenAt: now - 8 }), configuredBy: new Set(['net-a']), tag: 'cfg2' },
			{ ...discovered({ firstSeenAt: now - 2 }), tag: 'disc1' },
			{ ...discovered({ firstSeenAt: now - 1 }), tag: 'disc2' },
		];
		expect(pruneBootstrapEntries(entries, now, 100, 2).map(e => e.tag)).toEqual(['cfg1', 'cfg2', 'disc1', 'disc2']);
	});

	/**
	 * Registry membership also decides whether a peer is re-tagged KEEP_ALIVE when it
	 * connects, and that tag drives libp2p's reconnect queue. Ageing out a peer purely
	 * because the connection has been up longer than the TTL would silently demote the
	 * healthiest peers we have.
	 */
	it('never expires a discovered entry whose peer is connected right now', () => {
		const entries = [discovered({ firstSeenAt: now - 10_000, peerID: PEER_A })];
		expect(pruneBootstrapEntries(entries, now, 100, 10, pid => pid === PEER_A)).toEqual(entries);
	});

	it('expires that same entry once the peer is no longer connected', () => {
		expect(pruneBootstrapEntries([discovered({ firstSeenAt: now - 10_000, peerID: PEER_A })], now, 100, 10, () => false)).toEqual([]);
	});
});

describe('Network bootstrap registry pruning', () => {
	const expiredAt = Date.now() - 3 * 60 * 60_000;

	it('prunes an expired discovered entry while another live connection keeps recovery idle', async () => {
		const { network, run } = bareNetwork({
			seeds: [{ address: ADDR_A, firstSeenAt: expiredAt }],
			livePeers: [PEER_B],
		});
		await run();
		expect(registryAddresses(network)).toEqual([]);
	});

	it('keeps an expired discovered entry while its own peer is connected', async () => {
		const { network, run } = bareNetwork({
			seeds: [{ address: ADDR_A, firstSeenAt: expiredAt }],
			livePeers: [PEER_A],
		});
		await run();
		expect(registryAddresses(network)).toEqual([key(ADDR_A)]);
	});

	it('removes an expired backoff whose address never entered the registry', async () => {
		const { network, run } = bareNetwork({ livePeers: [PEER_B] });
		(network as any).recoveryBackoff.set(key(ADDR_A), { nextAttempt: Date.now() - 1, failCount: 3 });
		await run();
		expect((network as any).recoveryBackoff.has(key(ADDR_A))).toBe(false);
	});
});

describe('orderBootstrapEntriesForRecovery', () => {
	const entries = [
		{ key: 'd1', configuredBy: new Set<string>(), tag: 'd1' },
		{ key: 'c1', configuredBy: new Set(['net-a']), tag: 'c1' },
		{ key: 'd2', configuredBy: new Set<string>(), tag: 'd2' },
		{ key: 'c2', configuredBy: new Set(['net-b']), tag: 'c2' },
	];

	it('puts configured entries first and preserves order inside each group', () => {
		expect(orderBootstrapEntriesForRecovery(entries).map(e => e.tag)).toEqual(['c1', 'c2', 'd1', 'd2']);
	});

	it('resumes each group after the entry the last pass stopped on', () => {
		expect(orderBootstrapEntriesForRecovery(entries, { configured: 'c1', discovered: 'd1' }).map(e => e.tag)).toEqual(['c2', 'c1', 'd2', 'd1']);
	});

	it('keeps configured entries ahead even when only they were rotated', () => {
		// One cursor over the whole list would eventually start a pass among the
		// discovered claims and leave the user's own bootstrap queued behind them.
		expect(orderBootstrapEntriesForRecovery(entries, { configured: 'c2', discovered: null }).map(e => e.tag)).toEqual(['c1', 'c2', 'd1', 'd2']);
	});

	it('restarts a group whose cursor entry has gone', () => {
		expect(orderBootstrapEntriesForRecovery(entries, { configured: 'removed', discovered: 'removed' }).map(e => e.tag)).toEqual(['c1', 'c2', 'd1', 'd2']);
	});
});

describe('nextRecoveryBackoff', () => {
	it('doubles the delay per consecutive failure of the same address', () => {
		expect(nextRecoveryBackoff(0, 0, false)).toEqual({ nextAttempt: 30_000, failCount: 1 });
		expect(nextRecoveryBackoff(1, 0, false)).toEqual({ nextAttempt: 60_000, failCount: 2 });
		expect(nextRecoveryBackoff(2, 0, false)).toEqual({ nextAttempt: 120_000, failCount: 3 });
	});

	it('caps a discovered address at 10 minutes', () => {
		expect(nextRecoveryBackoff(20, 0, false).nextAttempt).toBe(600_000);
	});

	/**
	 * A configured address is the user's designated way back in, so it is retried far
	 * more briskly than a gossip claim — but it is still paced, or a handful of dead
	 * configured entries would eat every recovery pass at 10 s apiece.
	 */
	it('caps a configured address at 2 minutes instead', () => {
		expect(nextRecoveryBackoff(20, 0, true).nextAttempt).toBe(120_000);
	});
});
