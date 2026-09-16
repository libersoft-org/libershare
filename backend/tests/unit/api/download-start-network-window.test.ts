import { describe, it, expect, beforeEach } from 'bun:test';
import { tmpdir } from 'os';
import { initTransferHandlers, initDownloadState, getDownloadEnabledLishs } from '../../../src/api/transfer.ts';
import { type Networks } from '../../../src/lishnet/lishnets.ts';
import { type DataServer } from '../../../src/lish/data-server.ts';
import { type Settings } from '../../../src/settings.ts';
import { Downloader } from '../../../src/protocol/downloader.ts';

/**
 * A download start spans several awaits before the downloader is registered, and both
 * the lishnet membership and the user's own enabled flag can change inside that window.
 * Neither change reaches the start through the usual routes — onNetworkLeft and
 * disableDownload only walk the active-downloader map, which this downloader has not
 * entered yet — so the start has to re-read both for itself.
 *
 * These drive the REAL handlers; only the lishnet and LISH stores underneath are stubbed.
 */

const LISH_ID = 'lish-window';
const NET_A = 'net-a';
const NET_B = 'net-b';

/** Recovery off, so a non-success outcome schedules no retry timer inside the test. */
const settings = { get: (): boolean => false } as unknown as Settings;

interface NetworksStub {
	networks: Networks;
	joined: Set<string>;
	join(id: string): void;
	leave(id: string): void;
	announceLeave(id: string): void;
	announceJoin(id: string): void;
	joinedHandler: (id: string) => void;
}

function makeNetworks(enabled: string[], joined: string[] = enabled): NetworksStub {
	const joinedSet = new Set(joined);
	let joinedHandler: (id: string) => void = () => {};
	let leftHandler: (id: string) => void = () => {};
	const networks = {
		getRunningNetwork: (): any => ({ onPeerDisconnect: (): (() => void) => () => {} }),
		getEnabled: (): any[] => enabled.map(networkID => ({ networkID })),
		isJoined: (id: string): boolean => joinedSet.has(id),
		set onNetworkLeft(cb: unknown) {
			leftHandler = cb as (id: string) => void;
		},
		set onNetworkJoined(cb: unknown) {
			joinedHandler = cb as (id: string) => void;
		},
	} as unknown as Networks;
	return {
		networks,
		joined: joinedSet,
		join: (id: string): void => void joinedSet.add(id),
		leave: (id: string): void => void joinedSet.delete(id),
		// The real handlers, so a leave/join in a test goes through the production path
		// instead of only flipping a flag the code under test happens to read.
		announceLeave: (id: string): void => {
			joinedSet.delete(id);
			leftHandler(id);
		},
		announceJoin: (id: string): void => {
			joinedSet.add(id);
			joinedHandler(id);
		},
		get joinedHandler() {
			return joinedHandler;
		},
	} as NetworksStub;
}

/**
 * A LISH store whose SECOND chunk read runs `duringInit`.
 *
 * The first read is the completeness check in the enable path, which happens before the
 * downloader exists — acting there would test the ordinary "no lishnet joined" branch
 * instead of the start window. The second is the downloader's own init, which is the one
 * place inside that window a test can act from.
 */
function makeDataServer(duringInit: () => void = () => {}): DataServer & { arm(fn: () => void): void } {
	let reads = 0;
	let pending: (() => void) | null = duringInit;
	// The enable path reads the chunk list once for its own completeness check before the
	// downloader exists, so a hook armed at construction has to skip that one. A hook armed
	// mid-test (the restore path) fires on the very next read, which is the init itself.
	let fireAt = 2;
	return {
		arm(fn: () => void): void {
			pending = fn;
			fireAt = reads + 1;
		},
		clearError: (): void => {},
		setError: (): void => {},
		// `directory: null` keeps the start on the no-pre-flight path.
		get: (): any => ({ id: LISH_ID, name: 'x', directory: null, files: [] }),
		getAllChunkCount: (): number => 4,
		isCompleteLISH: (): boolean => false,
		getMissingChunks: (): string[] => {
			reads++;
			if (pending && reads === fireAt) {
				const fire = pending;
				pending = null;
				fire();
			}
			return ['chunk-0'];
		},
	} as unknown as DataServer & { arm(fn: () => void): void };
}

describe('download start — the lishnet window', () => {
	beforeEach(() => {
		initDownloadState(new Set<string>(), () => {});
	});

	it('does not resurrect a download the user turned off while its lishnet was left', async () => {
		// Disable and leave land in the same window. The disable already cleared the resume
		// claim; filing a new one for the leave would turn the download back on at the next
		// rejoin — the one thing "off" has to survive.
		const net = makeNetworks([NET_A]);
		let handlers!: ReturnType<typeof initTransferHandlers>;
		const dataServer = makeDataServer(() => {
			handlers.disableDownload({ lishID: LISH_ID });
			net.leave(NET_A);
		});
		handlers = initTransferHandlers(net.networks, dataServer, tmpdir(), () => {}, undefined, settings);

		const result = await handlers.enableDownload({ lishID: LISH_ID });

		expect(result).toEqual({ success: false });
		expect(handlers.getActiveTransfers()).toEqual([]);
		// The rejoin must find nothing to resume.
		net.join(NET_A);
		net.joinedHandler(NET_A);
		await Promise.resolve();
		expect(getDownloadEnabledLishs().has(LISH_ID)).toBe(false);
		expect(handlers.getActiveTransfers()).toEqual([]);
	});

	it('keeps the full original binding when the attempt ran on a subset', async () => {
		// A restore is the production path where the two lists genuinely differ: the snapshot
		// carries the download's binding (A and B) while only A can be used right now. A drops
		// again inside the start window. Claiming only A would make a later join of B — a
		// lishnet the download is entitled to source from — stop looking like a reason to
		// resume it.
		const net = makeNetworks([NET_A, NET_B], [NET_A]);
		const dataServer = makeDataServer();
		const events: Array<{ event: string; data: any }> = [];
		const handlers = initTransferHandlers(net.networks, dataServer, tmpdir(), () => {}, (event: string, data: any) => events.push({ event, data }), settings);

		dataServer.arm(() => net.leave(NET_A));
		await handlers.restoreAll(new Set([LISH_ID]), new Map([[LISH_ID, { networkIDs: [NET_A], originalNetworkIDs: [NET_A, NET_B], disabled: false, suspended: true }]]));
		expect(handlers.getActiveTransfers()).toEqual([]);

		// B comes back. It is part of the original binding, so it must resume the download.
		// Asserted on the broadcast rather than the active list: with a stubbed network the
		// download itself settles almost immediately and leaves the map again, so the list
		// would answer about the transfer's lifetime instead of whether B resumed it.
		events.length = 0;
		net.announceJoin(NET_B);
		await new Promise(resolve => setTimeout(resolve, 20));

		expect(events.filter(e => e.event === 'transfer.download:enabled').map(e => e.data.lishID)).toEqual([LISH_ID]);
	});

	it('drops only the lishnet that was left when another one survives', async () => {
		// A is left mid-start, B stays. The download goes ahead — on B alone. Keeping A in
		// the active set would keep publishing WANTs on a topic we are no longer in:
		// broadcast() and publishOn() take the network they are handed and never re-check
		// membership. Spied on the downloader itself, since the active set is not otherwise
		// visible from outside the handlers.
		const removed: string[] = [];
		const original = Downloader.prototype.removeNetwork;
		Downloader.prototype.removeNetwork = function (networkID: string): void {
			removed.push(networkID);
			return original.call(this, networkID);
		};
		try {
			const net = makeNetworks([NET_A, NET_B]);
			const dataServer = makeDataServer(() => net.leave(NET_A));
			const handlers = initTransferHandlers(net.networks, dataServer, tmpdir(), () => {}, undefined, settings);

			const result = await handlers.enableDownload({ lishID: LISH_ID });

			expect(result).toEqual({ success: true });
			expect(handlers.getActiveTransfers().map(t => t.lishID)).toEqual([LISH_ID]);
			expect(removed).toEqual([NET_A]);
		} finally {
			Downloader.prototype.removeNetwork = original;
		}
	});

	it('keeps the last manual switch when it lands during a start', async () => {
		// enable → disable → enable, all inside one start window. The middle disable aborts
		// the running attempt; the second enable only waits for that attempt, so without a
		// record of what the user asked for LAST it reads a switched-off download and agrees
		// with it. The user's last word was "on".
		const net = makeNetworks([NET_A]);
		let handlers!: ReturnType<typeof initTransferHandlers>;
		let second: Promise<{ success: boolean }> | null = null;
		const dataServer = makeDataServer(() => {
			handlers.disableDownload({ lishID: LISH_ID });
			second = handlers.enableDownload({ lishID: LISH_ID });
		});
		handlers = initTransferHandlers(net.networks, dataServer, tmpdir(), () => {}, undefined, settings);

		const first = await handlers.enableDownload({ lishID: LISH_ID });
		expect(first).toEqual({ success: false });

		expect(await second!).toEqual({ success: true });
		expect(handlers.getActiveTransfers().map(t => t.lishID)).toEqual([LISH_ID]);
	});

	it('lets a manual switch off win over a resume that is still settling', async () => {
		// The mirror image, and the reason the record is written only by the manual path: a
		// disable arriving last must not be undone by the re-ask.
		const net = makeNetworks([NET_A]);
		let handlers!: ReturnType<typeof initTransferHandlers>;
		let second: Promise<{ success: boolean }> | null = null;
		const dataServer = makeDataServer(() => {
			second = handlers.enableDownload({ lishID: LISH_ID });
			handlers.disableDownload({ lishID: LISH_ID });
		});
		handlers = initTransferHandlers(net.networks, dataServer, tmpdir(), () => {}, undefined, settings);

		await handlers.enableDownload({ lishID: LISH_ID });

		expect(await second!).toEqual({ success: false });
		expect(handlers.getActiveTransfers()).toEqual([]);
	});

});
