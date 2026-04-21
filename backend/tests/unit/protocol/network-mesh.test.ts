import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { LISH_TOPIC_PREFIX, DEFAULT_ACCEPT_PX_THRESHOLD, lishTopic, normalizeTrustedPeerIds, parseAcceptPXThreshold } from '../../../src/protocol/constants.ts';

const NETWORK_TS = readFileSync(join(__dirname, '../../../src/protocol/network.ts'), 'utf-8');
const CONFIG_TS = readFileSync(join(__dirname, '../../../src/protocol/network-config.ts'), 'utf-8');
const SETTINGS_TS = readFileSync(join(__dirname, '../../../src/settings.ts'), 'utf-8');

// ---------------------------------------------------------------------------
// GossipSub parameter constraint validation
// ---------------------------------------------------------------------------

describe('GossipSub constraints — parameter relationships', () => {
	// Extract values from network-config.ts source
	const D = parseInt(CONFIG_TS.match(/\bD:\s*(\d+)/)?.[1] ?? '0');
	const Dlo = parseInt(CONFIG_TS.match(/\bDlo:\s*(\d+)/)?.[1] ?? '0');
	const Dhi = parseInt(CONFIG_TS.match(/\bDhi:\s*(\d+)/)?.[1] ?? '0');
	const Dout = parseInt(CONFIG_TS.match(/\bDout:\s*(\d+)/)?.[1] ?? '-1');
	const Dlazy = parseInt(CONFIG_TS.match(/\bDlazy:\s*(\d+)/)?.[1] ?? '0');

	it('values are extracted from config', () => {
		expect(D).toBeGreaterThan(0);
		expect(Dlo).toBeGreaterThan(0);
		expect(Dhi).toBeGreaterThan(0);
		expect(Dout).toBeGreaterThanOrEqual(0);
		expect(Dlazy).toBeGreaterThan(0);
	});

	it('Dlo <= D (lower bound <= desired)', () => {
		expect(Dlo).toBeLessThanOrEqual(D);
	});

	it('D <= Dhi (desired <= upper bound)', () => {
		expect(D).toBeLessThanOrEqual(Dhi);
	});

	it('Dout < Dlo (outbound < lower bound — hard GossipSub constraint)', () => {
		expect(Dout).toBeLessThan(Dlo);
	});

	it('Dout <= D/2 (outbound <= half of desired — hard GossipSub constraint)', () => {
		expect(Dout).toBeLessThanOrEqual(Math.floor(D / 2));
	});

	it('Dout is explicitly set (not relying on default)', () => {
		expect(CONFIG_TS).toMatch(/Dout:\s*\d/);
	});

	it('Dlazy >= 1 (at least 1 lazy gossip peer)', () => {
		expect(Dlazy).toBeGreaterThanOrEqual(1);
	});

	it('D >= 2 (mesh needs at least 2 peers for redundancy)', () => {
		expect(D).toBeGreaterThanOrEqual(2);
	});

	it('Dhi - D >= 2 (headroom for mesh growth)', () => {
		expect(Dhi - D).toBeGreaterThanOrEqual(2);
	});

	it('D - Dlo >= 1 (buffer before emergency grafting)', () => {
		expect(D - Dlo).toBeGreaterThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// GossipSub config options
// ---------------------------------------------------------------------------

describe('network-config.ts — gossipsub options', () => {
	it('floodPublish enabled for small networks', () => {
		expect(CONFIG_TS).toContain('floodPublish: true');
	});

	it('emitSelf disabled', () => {
		expect(CONFIG_TS).toContain('emitSelf: false');
	});

	it('heartbeatInterval is set', () => {
		expect(CONFIG_TS).toMatch(/heartbeatInterval:\s*\d+/);
	});

	it('fanoutTTL is set', () => {
		expect(CONFIG_TS).toMatch(/fanoutTTL:\s*\d+/);
	});
});

describe('network-config.ts — PX trust policy', () => {
	it('does not enable PX unconditionally', () => {
		expect(CONFIG_TS).toContain('doPX: pxEnabled');
		expect(CONFIG_TS).not.toContain('doPX: true');
	});

	it('does not use bootstrap peers as app-specific PX trust', () => {
		const scoreBlock = CONFIG_TS.slice(CONFIG_TS.indexOf('appSpecificScore'), CONFIG_TS.indexOf('IPColocationFactorWeight'));
		expect(scoreBlock).toContain('pxEnabled && isConfiguredTrustedPXPeer');
		expect(scoreBlock).not.toContain('bootstrapPeerIDs.has');
	});

	it('uses a positive acceptPXThreshold from local policy', () => {
		expect(CONFIG_TS).toContain('acceptPXThreshold,');
		expect(CONFIG_TS).not.toContain('acceptPXThreshold: 0');
	});

	it('defaults PX policy to fail closed', () => {
		const defaultsStart = SETTINGS_TS.indexOf('const DEFAULT_SETTINGS');
		const peerExchangeStart = SETTINGS_TS.indexOf('peerExchange: {', defaultsStart);
		const defaultBlock = SETTINGS_TS.slice(peerExchangeStart, SETTINGS_TS.indexOf('system:', peerExchangeStart));
		expect(defaultBlock).toContain('enabled: false');
		expect(defaultBlock).toContain('acceptPXThreshold: 10');
		expect(defaultBlock).toContain('trustedPeerIds: []');
		expect(defaultBlock).toContain('ingressFilterEnabled: false');
	});
});

describe('network.ts — PX ingress filter (source surface)', () => {
	it('filters incoming PX before gossipsub handles PRUNE', () => {
		const filterBlock = NETWORK_TS.slice(NETWORK_TS.indexOf('patchGossipsubPXIngressPolicyOnce'), NETWORK_TS.indexOf('private addListener'));
		expect(filterBlock).toContain('handleReceivedRpc');
		expect(filterBlock).toContain('ingressFilterEnabled');
		expect(filterBlock).toContain('trusted.has(sender)');
		expect(filterBlock).toContain('LISH_TOPIC_PREFIX');
		expect(filterBlock).toContain('peers: []');
		expect(filterBlock).toContain('throw new Error');
	});
});

// ---------------------------------------------------------------------------
// PX ingress filter — behavioural coverage (re-implements the strip logic as a
// pure function against the same helpers the runtime uses, so drift between
// this test and the runtime wrapper in network.ts is detected by the source
// surface check above).
// ---------------------------------------------------------------------------

type PruneControl = { topicID?: string; peers?: Array<{ peerID?: Uint8Array }> };
type RPC = { control?: { prune?: PruneControl[] } };
type FilterSettings = { enabled: boolean; ingressFilterEnabled: boolean; trustedPeerIds: string[] };

function applyPXIngressFilter(peerExchange: FilterSettings, sender: string, rpc: RPC): { prune: PruneControl[]; allowed: number; stripped: number } {
	const prunes = rpc.control?.prune ?? [];
	if (!peerExchange.ingressFilterEnabled || prunes.length === 0) return { prune: prunes, allowed: 0, stripped: 0 };
	const trusted = normalizeTrustedPeerIds(peerExchange.trustedPeerIds);
	let allowed = 0;
	let stripped = 0;
	const prune = prunes.map(p => {
		if (!p?.peers?.length) return p;
		const topic = p.topicID;
		const allowPX = peerExchange.enabled === true && trusted.has(sender) && typeof topic === 'string' && topic.startsWith(LISH_TOPIC_PREFIX);
		if (allowPX) {
			allowed++;
			return p;
		}
		stripped++;
		return { ...p, peers: [] };
	});
	return { prune, allowed, stripped };
}

describe('PX ingress filter — behavioural', () => {
	const fakePeer = { peerID: new Uint8Array([1, 2, 3]) };
	const prune = (topicID: string, peerCount = 2): PruneControl => ({
		topicID,
		peers: Array.from({ length: peerCount }, () => fakePeer),
	});

	it('is a no-op when ingressFilterEnabled=false', () => {
		const rpc: RPC = { control: { prune: [prune('lish/n1')] } };
		const out = applyPXIngressFilter({ enabled: true, ingressFilterEnabled: false, trustedPeerIds: ['sender1'] }, 'sender1', rpc);
		expect(out.allowed).toBe(0);
		expect(out.stripped).toBe(0);
		expect(out.prune[0]!.peers!.length).toBe(2); // untouched
	});

	it('is a no-op when RPC has no PRUNE control', () => {
		const rpc: RPC = { control: { prune: [] } };
		const out = applyPXIngressFilter({ enabled: true, ingressFilterEnabled: true, trustedPeerIds: ['sender1'] }, 'sender1', rpc);
		expect(out.stripped).toBe(0);
		expect(out.allowed).toBe(0);
	});

	it('strips peers when sender is not trusted (lish topic)', () => {
		const rpc: RPC = { control: { prune: [prune('lish/n1')] } };
		const out = applyPXIngressFilter({ enabled: true, ingressFilterEnabled: true, trustedPeerIds: ['someoneElse'] }, 'untrustedSender', rpc);
		expect(out.stripped).toBe(1);
		expect(out.allowed).toBe(0);
		expect(out.prune[0]!.peers).toEqual([]);
	});

	it('strips peers when topic is outside the lish namespace (trusted sender)', () => {
		const rpc: RPC = { control: { prune: [prune('other/n1')] } };
		const out = applyPXIngressFilter({ enabled: true, ingressFilterEnabled: true, trustedPeerIds: ['trustedSender'] }, 'trustedSender', rpc);
		expect(out.stripped).toBe(1);
		expect(out.allowed).toBe(0);
		expect(out.prune[0]!.peers).toEqual([]);
	});

	it('strips peers when enabled=false even if sender is in trustedPeerIds (defence-in-depth)', () => {
		const rpc: RPC = { control: { prune: [prune('lish/n1')] } };
		const out = applyPXIngressFilter({ enabled: false, ingressFilterEnabled: true, trustedPeerIds: ['trustedSender'] }, 'trustedSender', rpc);
		expect(out.stripped).toBe(1);
		expect(out.allowed).toBe(0);
	});

	it('allows PX when trusted sender AND lish topic AND enabled', () => {
		const rpc: RPC = { control: { prune: [prune('lish/n1', 3)] } };
		const out = applyPXIngressFilter({ enabled: true, ingressFilterEnabled: true, trustedPeerIds: ['trustedSender'] }, 'trustedSender', rpc);
		expect(out.allowed).toBe(1);
		expect(out.stripped).toBe(0);
		expect(out.prune[0]!.peers!.length).toBe(3);
	});

	it('leaves PRUNE frames without peers untouched', () => {
		const rpc: RPC = { control: { prune: [{ topicID: 'lish/n1', peers: [] }] } };
		const out = applyPXIngressFilter({ enabled: true, ingressFilterEnabled: true, trustedPeerIds: ['untrusted'] }, 'untrusted', rpc);
		expect(out.stripped).toBe(0);
		expect(out.allowed).toBe(0);
	});

	it('treats lish-lookalike topics strictly by prefix (no PX on "lishother/")', () => {
		const rpc: RPC = { control: { prune: [prune('lish/n1'), prune('other-lish/n2')] } };
		const out = applyPXIngressFilter({ enabled: true, ingressFilterEnabled: true, trustedPeerIds: ['trustedSender'] }, 'trustedSender', rpc);
		expect(out.allowed).toBe(1);
		expect(out.stripped).toBe(1);
		expect(out.prune[0]!.peers!.length).toBe(2);
		expect(out.prune[1]!.peers).toEqual([]);
	});

	it('handles malformed trustedPeerIds (non-strings, empty strings, whitespace) safely', () => {
		const rpc: RPC = { control: { prune: [prune('lish/n1')] } };
		const out = applyPXIngressFilter({ enabled: true, ingressFilterEnabled: true, trustedPeerIds: ['  trustedSender  ', '', null as any, 42 as any, '   '] }, 'trustedSender', rpc);
		expect(out.allowed).toBe(1);
		expect(out.stripped).toBe(0);
	});

	it('mixes allowed and stripped prunes in a single RPC', () => {
		const rpc: RPC = { control: { prune: [prune('lish/n1'), prune('lish/n2'), prune('other/topic')] } };
		const out = applyPXIngressFilter({ enabled: true, ingressFilterEnabled: true, trustedPeerIds: ['trustedSender'] }, 'trustedSender', rpc);
		expect(out.allowed).toBe(2);
		expect(out.stripped).toBe(1);
		expect(out.prune[0]!.peers!.length).toBe(2);
		expect(out.prune[1]!.peers!.length).toBe(2);
		expect(out.prune[2]!.peers).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Shared helpers (normalize / parseAcceptPXThreshold) — used by both
// network-config.ts and network.ts so drift is impossible.
// ---------------------------------------------------------------------------

describe('normalizeTrustedPeerIds helper', () => {
	it('returns empty Set for non-array inputs', () => {
		expect(normalizeTrustedPeerIds(undefined).size).toBe(0);
		expect(normalizeTrustedPeerIds(null).size).toBe(0);
		expect(normalizeTrustedPeerIds('single' as any).size).toBe(0);
		expect(normalizeTrustedPeerIds({} as any).size).toBe(0);
	});

	it('filters non-string entries', () => {
		const out = normalizeTrustedPeerIds([123, null, undefined, {}, 'ok']);
		expect(out.size).toBe(1);
		expect(out.has('ok')).toBe(true);
	});

	it('trims surrounding whitespace and drops empty strings', () => {
		const out = normalizeTrustedPeerIds(['  a  ', '', '   ', 'b']);
		expect(out.size).toBe(2);
		expect(out.has('a')).toBe(true);
		expect(out.has('b')).toBe(true);
	});

	it('deduplicates case-sensitively', () => {
		const out = normalizeTrustedPeerIds(['a', 'a', 'A']);
		expect(out.size).toBe(2);
	});
});

describe('parseAcceptPXThreshold helper', () => {
	it('accepts positive finite numbers as-is', () => {
		expect(parseAcceptPXThreshold(25)).toEqual({ value: 25, unsafe: false, raw: 25 });
		expect(parseAcceptPXThreshold(1)).toEqual({ value: 1, unsafe: false, raw: 1 });
	});

	it('flags zero and negative numbers as unsafe and falls back to default', () => {
		const z = parseAcceptPXThreshold(0);
		expect(z.unsafe).toBe(true);
		expect(z.value).toBe(DEFAULT_ACCEPT_PX_THRESHOLD);
		const n = parseAcceptPXThreshold(-5);
		expect(n.unsafe).toBe(true);
		expect(n.value).toBe(DEFAULT_ACCEPT_PX_THRESHOLD);
	});

	it('flags non-numbers and non-finite values as unsafe', () => {
		expect(parseAcceptPXThreshold('10' as any).unsafe).toBe(true);
		expect(parseAcceptPXThreshold(NaN).unsafe).toBe(true);
		expect(parseAcceptPXThreshold(Infinity).unsafe).toBe(true);
		expect(parseAcceptPXThreshold(-Infinity).unsafe).toBe(true);
		expect(parseAcceptPXThreshold(undefined).unsafe).toBe(true);
		expect(parseAcceptPXThreshold(null).unsafe).toBe(true);
	});

	it('returns the raw value for logging even when unsafe', () => {
		expect(parseAcceptPXThreshold(-1).raw).toBe(-1);
		expect(parseAcceptPXThreshold('bogus' as any).raw).toBe('bogus');
	});
});

// ---------------------------------------------------------------------------
// lishTopic helper
// ---------------------------------------------------------------------------

describe('lishTopic helper', () => {
	it('returns correct topic format', () => {
		expect(lishTopic('abc-123')).toBe('lish/abc-123');
	});

	it('handles UUID-format network IDs', () => {
		const uuid = 'e92c238f-15be-49ea-b626-5eef330c1920';
		expect(lishTopic(uuid)).toBe(`lish/${uuid}`);
	});
});

// ---------------------------------------------------------------------------
// Peer count check scheduling — source code verification
// ---------------------------------------------------------------------------

describe('subscribeTopic — peer count scheduling', () => {
	it('schedules 3 delayed peer count checks after subscribe', () => {
		const subscribeBlock = NETWORK_TS.slice(NETWORK_TS.indexOf('subscribeTopic(networkID: string)'), NETWORK_TS.indexOf('unsubscribeHandler'));
		const matches = subscribeBlock.match(/setTimeout\(\(\) => this\.schedulePeerCountCheck\(\)/g);
		expect(matches).not.toBeNull();
		expect(matches!.length).toBe(3);
	});

	it('uses delays 2s, 5s, 15s for mesh rebuild', () => {
		const subscribeBlock = NETWORK_TS.slice(NETWORK_TS.indexOf('subscribeTopic(networkID: string)'), NETWORK_TS.indexOf('unsubscribeHandler'));
		expect(subscribeBlock).toContain('2000');
		expect(subscribeBlock).toContain('5000');
		expect(subscribeBlock).toContain('15000');
	});
});

describe('unsubscribeTopic — peer count scheduling', () => {
	it('calls schedulePeerCountCheck immediately', () => {
		const unsubBlock = NETWORK_TS.slice(NETWORK_TS.indexOf('unsubscribeTopic(networkID: string)'), NETWORK_TS.indexOf('getTopicPeers'));
		expect(unsubBlock).toContain('this.schedulePeerCountCheck()');
	});
});

describe('statusInterval — periodic peer count refresh', () => {
	it('calls checkPeerCounts in status interval', () => {
		const startIdx = NETWORK_TS.indexOf('private setupStatusInterval');
		const endIdx = NETWORK_TS.indexOf('\n\t}', startIdx + 50);
		const statusBlock = NETWORK_TS.slice(startIdx, endIdx);
		expect(statusBlock).toContain('this.checkPeerCounts()');
	});

	it('uses console.debug for status log (not console.log)', () => {
		const startIdx = NETWORK_TS.indexOf('private setupStatusInterval');
		const endIdx = NETWORK_TS.indexOf('\n\t}', startIdx + 50);
		const statusBlock = NETWORK_TS.slice(startIdx, endIdx);
		expect(statusBlock).toContain('console.debug');
		// Should NOT use console.log for status
		const statusLogLine = statusBlock.match(/console\.log\(`📊 Status/);
		expect(statusLogLine).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// checkPeerCounts algorithm — tested in isolation
// ---------------------------------------------------------------------------

describe('checkPeerCounts logic', () => {
	function checkPeerCountsLogic(topics: string[], getSubscribers: (topic: string) => string[], lastCounts: Map<string, number>): { changed: boolean; counts: { networkID: string; count: number }[] } {
		const prefix = 'lish/';
		let changed = false;
		const counts: { networkID: string; count: number }[] = [];
		for (const topic of topics) {
			if (!topic.startsWith(prefix)) continue;
			const networkID = topic.slice(prefix.length);
			let count = 0;
			try {
				count = getSubscribers(topic).length;
			} catch {}
			const prev = lastCounts.get(networkID) ?? -1;
			if (count !== prev) changed = true;
			lastCounts.set(networkID, count);
			counts.push({ networkID, count });
		}
		const currentNetworkIDs = new Set(counts.map(c => c.networkID));
		for (const [id] of lastCounts) {
			if (!currentNetworkIDs.has(id)) {
				lastCounts.delete(id);
				changed = true;
			}
		}
		return { changed, counts };
	}

	it('detects new subscribers on a topic', () => {
		const lastCounts = new Map<string, number>();
		const result = checkPeerCountsLogic(['lish/net1', 'lish/net2'], topic => (topic === 'lish/net1' ? ['peerA'] : ['peerA', 'peerB']), lastCounts);
		expect(result.changed).toBe(true);
		expect(result.counts).toEqual([
			{ networkID: 'net1', count: 1 },
			{ networkID: 'net2', count: 2 },
		]);
	});

	it('reports no change when counts are same', () => {
		const lastCounts = new Map<string, number>([
			['net1', 1],
			['net2', 2],
		]);
		const result = checkPeerCountsLogic(['lish/net1', 'lish/net2'], topic => (topic === 'lish/net1' ? ['peerA'] : ['peerA', 'peerB']), lastCounts);
		expect(result.changed).toBe(false);
	});

	it('detects count increase', () => {
		const lastCounts = new Map<string, number>([['net1', 1]]);
		const result = checkPeerCountsLogic(['lish/net1'], () => ['peerA', 'peerB', 'peerC'], lastCounts);
		expect(result.changed).toBe(true);
		expect(result.counts[0]!.count).toBe(3);
	});

	it('detects count decrease', () => {
		const lastCounts = new Map<string, number>([['net1', 3]]);
		const result = checkPeerCountsLogic(['lish/net1'], () => ['peerA'], lastCounts);
		expect(result.changed).toBe(true);
		expect(result.counts[0]!.count).toBe(1);
	});

	it('detects count going to zero', () => {
		const lastCounts = new Map<string, number>([['net1', 2]]);
		const result = checkPeerCountsLogic(['lish/net1'], () => [], lastCounts);
		expect(result.changed).toBe(true);
		expect(result.counts[0]!.count).toBe(0);
	});

	it('detects removed topic', () => {
		const lastCounts = new Map<string, number>([
			['net1', 1],
			['net2', 2],
		]);
		const result = checkPeerCountsLogic(['lish/net1'], () => ['peerA'], lastCounts);
		expect(result.changed).toBe(true);
		expect(result.counts.length).toBe(1);
		expect(lastCounts.has('net2')).toBe(false);
	});

	it('ignores non-lish topics', () => {
		const lastCounts = new Map<string, number>();
		const result = checkPeerCountsLogic(['other1', 'other2', 'lish/net1'], topic => (topic === 'lish/net1' ? ['peerA'] : ['shouldBeIgnored']), lastCounts);
		expect(result.counts.length).toBe(1);
		expect(result.counts[0]!.networkID).toBe('net1');
	});

	it('handles getSubscribers throwing error gracefully', () => {
		const lastCounts = new Map<string, number>();
		const result = checkPeerCountsLogic(
			['lish/net1'],
			() => {
				throw new Error('not subscribed');
			},
			lastCounts
		);
		expect(result.changed).toBe(true);
		expect(result.counts[0]!.count).toBe(0);
	});

	it('first call always reports changed (from -1 sentinel)', () => {
		const lastCounts = new Map<string, number>();
		const result = checkPeerCountsLogic(['lish/net1'], () => [], lastCounts);
		expect(result.changed).toBe(true);
	});

	it('handles multiple topics with mixed changes', () => {
		const lastCounts = new Map<string, number>([
			['net1', 1],
			['net2', 2],
			['net3', 0],
		]);
		const result = checkPeerCountsLogic(
			['lish/net1', 'lish/net2', 'lish/net3'],
			topic => {
				if (topic === 'lish/net1') return ['peerA'];
				if (topic === 'lish/net2') return ['peerA', 'peerB', 'peerC'];
				return [];
			},
			lastCounts
		);
		expect(result.changed).toBe(true);
		expect(result.counts.find(c => c.networkID === 'net2')!.count).toBe(3);
		expect(result.counts.find(c => c.networkID === 'net1')!.count).toBe(1);
	});

	it('consecutive calls without changes return changed=false', () => {
		const lastCounts = new Map<string, number>();
		const getSubscribers = () => ['peerA', 'peerB'];
		const topics = ['lish/net1'];

		const r1 = checkPeerCountsLogic(topics, getSubscribers, lastCounts);
		expect(r1.changed).toBe(true);

		const r2 = checkPeerCountsLogic(topics, getSubscribers, lastCounts);
		expect(r2.changed).toBe(false);

		const r3 = checkPeerCountsLogic(topics, getSubscribers, lastCounts);
		expect(r3.changed).toBe(false);
	});
});
