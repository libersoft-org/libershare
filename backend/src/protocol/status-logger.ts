import { Circuit } from '@multiformats/multiaddr-matcher';
import { parseAcceptPXThreshold } from './constants.ts';
import { trace } from '../logger.ts';
import { type Settings } from '../settings.ts';

/**
 * Dependencies required by the status-logging functions.
 * All fields are readonly; mutable state (lastScores) is passed by reference
 * so Network remains the single source of truth for that Map.
 */
export interface StatusLoggerDeps {
	readonly node: any;
	readonly pubsub: any;
	readonly settings: Settings;
	readonly lastScores: Map<string, number>;
}

/**
 * Emit detailed connection and gossipsub stream state to console.debug.
 * Reads only — does not mutate any dep field.
 */
export function logStatusDebug(deps: StatusLoggerDeps, connectedPeers: any[], allPeers: any[]): void {
	const { node, pubsub } = deps;
	// Detailed connection info per peer
	const peerDetails = connectedPeers.map(p => {
		const conns = node!.getConnections(p);
		const types = conns.map((c: any) => {
			const isRelay = Circuit.matches(c.remoteAddr);
			const limited = (c as any).limits != null;
			return `${isRelay ? 'R' : 'D'}${limited ? 'L' : ''}`;
		});
		return `${p.toString().slice(0, 12)}[${types.join(',')}]`;
	});
	const topicInfo = pubsub!
		.getTopics()
		.map((t: string) => {
			const subs = pubsub!.getSubscribers(t);
			const mesh = (pubsub as any).getMeshPeers ? (pubsub as any).getMeshPeers(t) : [];
			return `${t.slice(0, 28)}[subs=${subs.length} mesh=${mesh.length}]`;
		})
		.join(' ');
	console.debug(`📊 Status: ${connectedPeers.length} connected, ${allPeers.length} in store, topics: ${topicInfo}`);
	console.debug(`   Peers: ${peerDetails.join(' | ') || '(none)'}`);
	// DEBUG: per-topic mesh members detail
	for (const t of pubsub!.getTopics()) {
		const subs = pubsub!.getSubscribers(t).map((p: any) => p.toString().slice(0, 12));
		const mesh = (pubsub as any).getMeshPeers ? (pubsub as any).getMeshPeers(t).map((p: any) => p.toString().slice(0, 12)) : [];
		console.debug(`   [MESH] ${t.slice(0, 28)} subs=[${subs.join(',')}] mesh=[${mesh.join(',')}]`);
	}
	// DEBUG: gossipsub stream state — outbound streams are mesh-graft prerequisite
	const gs: any = pubsub;
	if (gs?.streamsOutbound && gs?.streamsInbound) {
		const out = Array.from(gs.streamsOutbound.keys()).map((p: any) => p.toString().slice(0, 12));
		const inb = Array.from(gs.streamsInbound.keys()).map((p: any) => p.toString().slice(0, 12));
		const direct = gs.direct ? Array.from(gs.direct).map((p: any) => p.toString().slice(0, 12)) : [];
		console.debug(`   [GS-STREAMS] out=[${out.join(',')}] in=[${inb.join(',')}] direct=[${direct.join(',')}]`);
	}
	// Announced multiaddrs — if /p2p-circuit appears, relay reservation is active
	const myAddrs = node!.getMultiaddrs().map((ma: any) => ma.toString());
	const circuit = myAddrs.filter((a: string) => a.includes('/p2p-circuit'));
	console.debug(
		`   MyAddrs: ${myAddrs.length} total, ${circuit.length} /p2p-circuit${
			circuit.length > 0
				? ' (' +
					circuit
						.slice(0, 2)
						.map((a: string) => a.slice(0, 80))
						.join(' | ') +
					')'
				: ''
		}`
	);
}

/**
 * Dump gossipsub peer scores to console.debug / console.warn as appropriate.
 * Mutates deps.lastScores (by reference) — Network owns the Map, this function
 * updates it in-place so Network remains the single source of truth.
 */
export function dumpGossipsubScores(deps: StatusLoggerDeps, connectedPeers: any[]): void {
	const { pubsub, settings, lastScores } = deps;
	// Gossipsub peer scoring — dump top/bottom scores + deltas.
	// INFO: summary (top 3 + bottom 3 + threshold crossings).
	// DEBUG (trace): per-peer full breakdown when P2PFS_SCORE_DEBUG=1.
	try {
		const scoreSvc: any = (pubsub as any)?.score;
		if (scoreSvc && typeof scoreSvc.score === 'function') {
			const entries: Array<{ id: string; score: number; delta: number }> = [];
			const pxEligibilityThreshold = parseAcceptPXThreshold(settings.list().network.peerExchange?.acceptPXThreshold).value;
			for (const p of connectedPeers) {
				const pid = p.toString();
				const s = Number(scoreSvc.score(pid)) || 0;
				const prev = lastScores.get(pid);
				const delta = prev === undefined ? 0 : s - prev;
				entries.push({ id: pid, score: s, delta });
				// Threshold-crossing INFO logs
				if (prev !== undefined) {
					if (prev >= -80 && s < -80) console.warn(`[NET] peer ${pid.slice(0, 12)} entered graylist (score=${s.toFixed(1)})`);
					else if (prev < -80 && s >= -80) console.log(`[NET] peer ${pid.slice(0, 12)} left graylist (score=${s.toFixed(1)})`);
					else if (prev < pxEligibilityThreshold && s >= pxEligibilityThreshold) console.log(`[NET] peer ${pid.slice(0, 12)} now PX-eligible (score=${s.toFixed(1)}, threshold=${pxEligibilityThreshold})`);
					else if (prev >= pxEligibilityThreshold && s < pxEligibilityThreshold) console.log(`[NET] peer ${pid.slice(0, 12)} lost PX eligibility (score=${s.toFixed(1)}, threshold=${pxEligibilityThreshold})`);
				}
				lastScores.set(pid, s);
			}
			// Evict entries for peers no longer connected
			const connectedSet2 = new Set(connectedPeers.map(p => p.toString()));
			for (const k of lastScores.keys()) if (!connectedSet2.has(k)) lastScores.delete(k);
			if (entries.length > 0) {
				entries.sort((a, b) => b.score - a.score);
				const fmt = (e: { id: string; score: number; delta: number }): string => `${e.id.slice(0, 12)}=${e.score.toFixed(1)}${e.delta !== 0 ? (e.delta > 0 ? '(+' : '(') + e.delta.toFixed(1) + ')' : ''}`;
				const top = entries.slice(0, 3).map(fmt).join(' | ');
				const bot = entries.length > 3 ? entries.slice(-3).reverse().map(fmt).join(' | ') : '';
				console.debug(`   Scores top: ${top}${bot ? ' | bot: ' + bot : ''}`);
			}
			if (process.env['P2PFS_SCORE_DEBUG'] === '1' && entries.length > 0) {
				const fullDump = entries.map(e => `${e.id.slice(0, 16)}:${e.score.toFixed(2)}`).join(' ');
				trace(`[NET] full scores: ${fullDump}`);
			}
		}
	} catch (err: any) {
		trace(`[NET] score dump error: ${err?.message ?? err}`);
	}
}
