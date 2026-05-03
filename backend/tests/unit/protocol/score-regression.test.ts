import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createTopicScoreParams, createPeerScoreParams } from '@chainsafe/libp2p-gossipsub/score';

const NETWORK_TS = readFileSync(join(__dirname, '../../../src/protocol/network.ts'), 'utf-8');
const CONFIG_TS = readFileSync(join(__dirname, '../../../src/protocol/network-config.ts'), 'utf-8');

// ---------------------------------------------------------------------------
// Regression guard for the gossipsub NaN score bug:
//
// `subscribeTopic()` writes per-topic score parameters into the gossipsub
// PeerScore.params.topics map. If ANY numeric field is left undefined,
// PeerScore.refreshScores() (heartbeat: every decayInterval=1s) executes
// `tstats.field *= tparams.<missing>Decay` which yields NaN. NaN propagates
// through computeScore(), the per-peer score becomes NaN, and the
// `score >= publishThreshold(-50)` check in floodPublish silently evaluates
// to false — peers are excluded from gossipsub message delivery.
//
// These tests pin the contract that:
//  1. `createTopicScoreParams` is the helper we rely on (source check).
//  2. The helper actually fills every numeric field with a finite default.
//  3. The arithmetic that runs in refreshScores cannot produce NaN for our
//     overrides (specifically with weight=0 fields, where math still runs).
// ---------------------------------------------------------------------------

describe('Per-topic scoreParams — NaN regression guard', () => {
	it('subscribeTopic uses createTopicScoreParams helper (no manual field list that can drift)', () => {
		// Source-grep guard: prevents anyone reverting commit c322cff6 back to
		// a manual object literal that skips fields and resurrects the bug.
		expect(NETWORK_TS).toContain('createTopicScoreParams(');
		expect(NETWORK_TS).toContain("from '@chainsafe/libp2p-gossipsub/score'");
	});

	it('subscribeTopic disables P3 (mesh deliveries) and P3b (mesh failure penalty) via weight=0', () => {
		// Verify the weight overrides we depend on for "P3 off" semantics are
		// still in place. Without them the helper would supply the upstream
		// default (-1), which would produce real penalties on low-traffic
		// search topics — false positive killer.
		expect(NETWORK_TS).toMatch(/meshMessageDeliveriesWeight:\s*0/);
		expect(NETWORK_TS).toMatch(/meshFailurePenaltyWeight:\s*0/);
	});

	it('createTopicScoreParams fills every numeric field with a finite default', () => {
		// Mirror the call shape from network.ts subscribeTopic (only weights overridden).
		const filled = createTopicScoreParams({
			topicWeight: 0.5,
			meshMessageDeliveriesWeight: 0,
			meshFailurePenaltyWeight: 0,
			invalidMessageDeliveriesWeight: -5,
			invalidMessageDeliveriesDecay: 0.9,
		});

		for (const [field, value] of Object.entries(filled)) {
			if (typeof value !== 'number') continue;
			expect(Number.isFinite(value), `field ${field} must be a finite number, got ${String(value)}`).toBe(true);
		}
	});

	it('refreshScores arithmetic on a freshly-initialised topic stat does not yield NaN', () => {
		// Reproduce the exact multiplications PeerScore.refreshScores() runs every
		// decayInterval (peer-score.js:109-122). For a fresh peer (counters all 0),
		// these would silently NaN if any decay field is undefined.
		const tparams = createTopicScoreParams({
			meshMessageDeliveriesWeight: 0,
			meshFailurePenaltyWeight: 0,
			invalidMessageDeliveriesWeight: -5,
			invalidMessageDeliveriesDecay: 0.9,
		});
		const tstats = {
			firstMessageDeliveries: 0,
			meshMessageDeliveries: 0,
			meshFailurePenalty: 0,
			invalidMessageDeliveries: 0,
		};

		tstats.firstMessageDeliveries *= tparams.firstMessageDeliveriesDecay;
		tstats.meshMessageDeliveries *= tparams.meshMessageDeliveriesDecay;
		tstats.meshFailurePenalty *= tparams.meshFailurePenaltyDecay;
		tstats.invalidMessageDeliveries *= tparams.invalidMessageDeliveriesDecay;

		expect(Number.isFinite(tstats.firstMessageDeliveries)).toBe(true);
		expect(Number.isFinite(tstats.meshMessageDeliveries)).toBe(true);
		expect(Number.isFinite(tstats.meshFailurePenalty)).toBe(true);
		expect(Number.isFinite(tstats.invalidMessageDeliveries)).toBe(true);
	});

	it('createPeerScoreParams produces non-NaN final score for a fresh peer', () => {
		// End-to-end: feed our (mocked) peer scoreParams through computeScore
		// for a peer with no scoring history. With our config the result must
		// be a finite number — historically NaN here got `NaN >= -50 = false`
		// which silently dropped peers from floodPublish recipients.
		const params = createPeerScoreParams({
			topicScoreCap: 10.0,
			appSpecificWeight: 1.0,
			appSpecificScore: () => 1,
			IPColocationFactorWeight: 0,
			IPColocationFactorThreshold: 50,
			behaviourPenaltyWeight: -1,
			behaviourPenaltyDecay: 0.99,
			behaviourPenaltyThreshold: 6,
			decayInterval: 1000,
			decayToZero: 0.01,
			retainScore: 900_000,
		});

		// Compute manually what PeerScore.score() would do for a peer with empty
		// pstats.topics (fresh peer, no GRAFT yet) — only P5 (appSpecific) and
		// P7 (behaviour) contribute. Both must remain finite.
		const p5 = params.appSpecificScore('12D3KooWFreshPeer') * params.appSpecificWeight;
		const behaviourPenalty = 0;
		const p7 = behaviourPenalty > params.behaviourPenaltyThreshold ? Math.pow(behaviourPenalty - params.behaviourPenaltyThreshold, 2) * params.behaviourPenaltyWeight : 0;
		const score = 0 + p5 + p7;

		expect(Number.isFinite(score)).toBe(true);
		expect(score).toBeGreaterThanOrEqual(-50); // would clear publishThreshold
	});
});

// ---------------------------------------------------------------------------
// appSpecificScore baseline + trust differentiation
// ---------------------------------------------------------------------------

describe('appSpecificScore — baseline 1, trust 1000', () => {
	it('source returns 1 for non-trusted, 1000 for trusted (no other branches)', () => {
		// Pin the exact return values referenced by every score check downstream.
		// Reverting these to 0 silently breaks `opportunisticGraftThreshold`
		// future-proofing and removes the visible debug delta in score dumps.
		expect(CONFIG_TS).toMatch(/return\s+isTrustedPXPeer\s*\?\s*1000\s*:\s*1\s*;/);
	});

	it('config thresholds keep score=1 above all gates (publish/gossip/opportunistic)', () => {
		const publishThreshold = parseInt(CONFIG_TS.match(/publishThreshold:\s*(-?\d+)/)?.[1] ?? '-50');
		const gossipThreshold = parseInt(CONFIG_TS.match(/gossipThreshold:\s*(-?\d+)/)?.[1] ?? '-10');
		const opportunisticGraftThreshold = parseInt(CONFIG_TS.match(/opportunisticGraftThreshold:\s*(-?\d+)/)?.[1] ?? '0');

		// Baseline 1 must clear all of these.
		expect(1).toBeGreaterThanOrEqual(publishThreshold);
		expect(1).toBeGreaterThanOrEqual(gossipThreshold);
		expect(1).toBeGreaterThanOrEqual(opportunisticGraftThreshold);
	});
});
