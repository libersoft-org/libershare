import { describe, expect, it } from 'bun:test';
import { nextEvictionWindowStart, shouldEvictUnreachablePeer } from '../../../src/protocol/network.ts';

/** The thresholds the production constants use, restated so a change to either is visible here. */
const EVICT_FAILS = 6;
const EVICT_MIN_MS = 30 * 60_000;
const NOW = 1_700_000_000_000;

describe('nextEvictionWindowStart', () => {
	it('keeps the original start while this node can reach someone', () => {
		const started = NOW - 20 * 60_000;
		expect(nextEvictionWindowStart(true, started, NOW)).toBe(started);
	});

	it('starts the window at the first failure when there is no earlier one', () => {
		expect(nextEvictionWindowStart(true, undefined, NOW)).toBe(NOW);
	});

	it('slides the window forward for every failure suffered while offline', () => {
		// This is the whole point: an hour of failures during a local outage must
		// not count towards the peer's unreachability.
		const started = NOW - 60 * 60_000;
		expect(nextEvictionWindowStart(false, started, NOW)).toBe(NOW);
	});
});

describe('shouldEvictUnreachablePeer', () => {
	const gone = { reachable: true, failCount: EVICT_FAILS, unreachableForMs: EVICT_MIN_MS, configured: false };

	it('evicts a peer that failed enough times over enough time', () => {
		expect(shouldEvictUnreachablePeer(gone)).toBe(true);
	});

	it('never evicts while this node has no other connection', () => {
		// A node that cannot reach anybody has no evidence about anybody. Without
		// this, a laptop waking after an hour asleep would purge its whole peerStore.
		expect(shouldEvictUnreachablePeer({ ...gone, reachable: false })).toBe(false);
	});

	it('never evicts a peer the operator configured by hand', () => {
		// Configured bootstrap peers are user data: they keep their red status row
		// through any outage rather than disappearing from the list.
		expect(shouldEvictUnreachablePeer({ ...gone, configured: true })).toBe(false);
	});

	it('waits for both the count and the duration, not either', () => {
		expect(shouldEvictUnreachablePeer({ ...gone, failCount: EVICT_FAILS - 1 })).toBe(false);
		expect(shouldEvictUnreachablePeer({ ...gone, unreachableForMs: EVICT_MIN_MS - 1 })).toBe(false);
	});

	it('keeps evicting once both thresholds are exceeded', () => {
		expect(shouldEvictUnreachablePeer({ ...gone, failCount: 50, unreachableForMs: 5 * EVICT_MIN_MS })).toBe(true);
	});
});

describe('the outage scenario the guard exists for', () => {
	it('does not evict on the first failure after an hour offline', () => {
		// Reproduces the reported defect: six failures accumulated while the host
		// itself was offline, then the connection returns. Before the fix the stored
		// window was an hour old, so this very first failure satisfied the duration
		// test and purged the peer.
		const windowStartedAt = NOW - 60 * 60_000;

		// Six failures during the outage: each one slides the window forward.
		let start = windowStartedAt;
		for (let failure = 1; failure <= EVICT_FAILS; failure++) start = nextEvictionWindowStart(false, start, NOW - (EVICT_FAILS - failure) * 1000);

		const firstFailureBackOnline = NOW;
		expect(shouldEvictUnreachablePeer({ reachable: true, failCount: EVICT_FAILS + 1, unreachableForMs: firstFailureBackOnline - start, configured: false })).toBe(false);
	});

	it('still evicts a peer that stays unreachable while we are online', () => {
		// The guard must not make eviction unreachable in practice — a genuinely
		// dead peer is still removed once the failures accumulate with us online.
		let start = nextEvictionWindowStart(true, undefined, NOW - EVICT_MIN_MS);
		for (let failure = 2; failure <= EVICT_FAILS; failure++) start = nextEvictionWindowStart(true, start, NOW);
		expect(shouldEvictUnreachablePeer({ reachable: true, failCount: EVICT_FAILS, unreachableForMs: NOW - start, configured: false })).toBe(true);
	});
});

describe('negative control', () => {
	/** The pre-fix behaviour: the window ran from the first failure regardless of our own reachability. */
	function windowStartBeforeFix(previous: number | undefined, now: number): number {
		return previous ?? now;
	}
	/** The pre-fix condition: count and duration only, with no notion of whether we were online. */
	function evictBeforeFix(failCount: number, unreachableForMs: number, configured: boolean): boolean {
		return failCount >= EVICT_FAILS && unreachableForMs >= EVICT_MIN_MS && !configured;
	}

	it('proves the scenario discriminates: the old logic evicts where the new one does not', () => {
		// Same inputs as "does not evict on the first failure after an hour offline".
		// If this assertion ever flips, the scenario stopped exercising the defect
		// and the test above would pass for the wrong reason.
		let start = NOW - 60 * 60_000;
		for (let failure = 1; failure <= EVICT_FAILS; failure++) start = windowStartBeforeFix(start, NOW - (EVICT_FAILS - failure) * 1000);

		expect(evictBeforeFix(EVICT_FAILS + 1, NOW - start, false)).toBe(true);
		expect(shouldEvictUnreachablePeer({ reachable: true, failCount: EVICT_FAILS + 1, unreachableForMs: NOW - nextEvictionWindowStart(false, start, NOW), configured: false })).toBe(false);
	});
});
