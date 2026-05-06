import { writable, derived, type Readable } from 'svelte/store';
import { api } from './api.ts';
import { connected } from './ws-client.ts';
import { tt } from './language.ts';
import { addNotification } from './notifications.ts';
// Reactive store of peer counts per network, updated via push events from backend, key: networkID, value: number of connected peers
export const peerCounts = writable<Record<string, number>>({});

/**
 * Per-network mesh health snapshot taken at the moment the most recent
 * `peers:count` event arrived. The frontend cannot keep a global server-side
 * clock in sync, so each entry is anchored against the browser's monotonic
 * `performance.now()` read at receive time (`anchor`) and the elapsed-since-
 * mesh-change is recomputed reactively elsewhere as
 * `performance.now() - anchor + stableSinceMs`. `performance.now()` (rather
 * than `Date.now()`) survives wall-clock jumps from suspend/resume or NTP
 * step adjustments — relying on `Date.now()` would let a laptop wake up and
 * spuriously flip the indicator to "stable".
 */
export interface MeshHealthEntry {
	meshSize: number;
	/** `null` when no graft/prune has ever been observed for the topic — the
	 * frontend treats this as "forming". A finite number is added to the
	 * elapsed time since `anchor` to derive the live "time since last
	 * mesh change". */
	stableSinceMs: number | null;
	medianScore: number | null;
	/** Browser monotonic time (`performance.now()`) at the moment the event
	 * was processed by the FE. */
	anchor: number;
}
export const meshHealth = writable<Record<string, MeshHealthEntry>>({});

// Aggregate summary derived from peerCounts (used by Footer LISH widget).
export interface NetworkSummary {
	connectedNetworks: number; // networks with at least one peer
	totalNetworks: number; // networks currently joined
	totalPeers: number; // sum of peers across all joined networks
}
export const networkSummary: Readable<NetworkSummary> = derived(peerCounts, $counts => {
	const values = Object.values($counts);
	const totalNetworks = values.length;
	let connectedNetworks = 0;
	let totalPeers = 0;
	for (const n of values) {
		totalPeers += n;
		if (n > 0) connectedNetworks++;
	}
	return { connectedNetworks, totalNetworks, totalPeers };
});

/**
 * Worst-case mesh state across all joined networks. The footer uses this to
 * colour the network icon — one bad network drags the indicator. The state
 * is intentionally fleet-size-agnostic: it inspects mesh stability through
 * time-since-last-graft/prune and median score, not absolute peer counts.
 */
export type MeshState = 'unknown' | 'forming' | 'unstable' | 'stable';
export interface MeshStatusOverview {
	state: MeshState;
	worstStableSinceMs: number;
	worstMedianScore: number | null;
}
const STABILITY_THRESHOLD_MS = 5000; // ≥ 5 heartbeats with no graft/prune

/**
 * Internal tick store nudged once per second so {@link meshStatus} re-evaluates
 * elapsed time without relying on backend pushes. The value is the browser's
 * monotonic `performance.now()` so it stays in lockstep with `anchor` even
 * across system-clock jumps.
 */
const _meshTick = writable<number>(typeof performance !== 'undefined' ? performance.now() : 0);
if (typeof window !== 'undefined') setInterval(() => _meshTick.set(performance.now()), 1000);

function evaluateMeshStatus(health: Record<string, MeshHealthEntry>, counts: Record<string, number>, now: number): MeshStatusOverview {
	const networkIDs = Object.keys(counts);
	if (networkIDs.length === 0) return { state: 'unknown', worstStableSinceMs: 0, worstMedianScore: null };
	const totalPeers = networkIDs.reduce((s, id) => s + (counts[id] ?? 0), 0);
	if (totalPeers === 0) return { state: 'forming', worstStableSinceMs: 0, worstMedianScore: null };
	let worstStable = Number.POSITIVE_INFINITY;
	let worstScore: number | null = null;
	let anyMeshEmpty = false;
	for (const id of networkIDs) {
		const entry = health[id];
		if (!entry) {
			// We have a known network but no health snapshot yet — treat as forming.
			anyMeshEmpty = true;
			continue;
		}
		if (entry.meshSize === 0) anyMeshEmpty = true;
		const elapsedSinceAnchor = Math.max(0, now - entry.anchor);
		// `stableSinceMs === null` ⇒ no graft/prune ever observed for this
		// topic; treat the worst-case as "forming" by leaving `worstStable` at
		// its current minimum and recording `anyMeshEmpty` if appropriate.
		const live = entry.stableSinceMs === null ? null : entry.stableSinceMs + elapsedSinceAnchor;
		if (live === null) anyMeshEmpty = true;
		else if (live < worstStable) worstStable = live;
		if (entry.medianScore !== null && (worstScore === null || entry.medianScore < worstScore)) worstScore = entry.medianScore;
	}
	const stableValue = Number.isFinite(worstStable) ? worstStable : 0;
	// Order matters: a negative median score means the heartbeat will start
	// pruning peers and routing is already degraded. That diagnosis trumps
	// "still forming" because a forming-but-otherwise-healthy mesh recovers
	// on its own; an unstable mesh needs operator attention. So check
	// `unstable` before `forming`, even when some other topic happens to be
	// empty.
	if (worstScore !== null && worstScore < 0) return { state: 'unstable', worstStableSinceMs: stableValue, worstMedianScore: worstScore };
	if (anyMeshEmpty) return { state: 'forming', worstStableSinceMs: stableValue, worstMedianScore: worstScore };
	if (!Number.isFinite(worstStable) || worstStable < STABILITY_THRESHOLD_MS) return { state: 'forming', worstStableSinceMs: stableValue, worstMedianScore: worstScore };
	return { state: 'stable', worstStableSinceMs: stableValue, worstMedianScore: worstScore };
}

/**
 * Mesh status overview, refreshed every second so the worst-case
 * `stableSinceMs` ticks forward without backend events.
 */
export const meshStatus: Readable<MeshStatusOverview> = derived([peerCounts, meshHealth, _meshTick], ([$counts, $health, $tick]) => evaluateMeshStatus($health, $counts, $tick));

let handlersRegistered = false;
let unsubListener: (() => void) | null = null;
let unsubReconnect: (() => void) | null = null;
let subscriberCount = 0;

// Register global event handlers for LISH network join/leave events. Should be called once during app initialization.
export async function initNetworkEvents(): Promise<void> {
	if (!handlersRegistered) {
		handlersRegistered = true;
		api.on('lishnets:joined', (data: { networkID: string; name: string }) => addNotification(tt('settings.lishNetwork.networkConnected', { name: data.name }), 'success'));
		api.on('lishnets:left', (data: { networkID: string; name: string }) => addNotification(tt('settings.lishNetwork.networkDisconnected', { name: data.name }), 'warning'));
		api.on('internet:status', (data: { online: boolean }) => {
			if (data.online) addNotification(tt('common.internetOnline'), 'success');
			else addNotification(tt('common.internetOffline'), 'error');
		});
	}
	// Subscribe on every connect (backend has fresh subscribedEvents after reconnect)
	api.subscribe('lishnets:joined');
	api.subscribe('lishnets:left');
	api.subscribe('internet:status');
}

// Subscribe to peer count updates from backend. Reference-counted so multiple callers (Footer widget + Settings page) can coexist.
export async function subscribePeerCounts(): Promise<void> {
	subscriberCount++;
	if (unsubListener) return; // already subscribed
	unsubListener = api.on('peers:count', (data: Array<{ networkID: string; count: number; meshSize?: number; stableSinceMs?: number | null; medianScore?: number | null }>) => {
		const counts: Record<string, number> = {};
		const health: Record<string, MeshHealthEntry> = {};
		const now = performance.now();
		for (const entry of data) {
			counts[entry.networkID] = entry.count;
			if (entry.meshSize !== undefined) {
				health[entry.networkID] = {
					meshSize: entry.meshSize,
					stableSinceMs: entry.stableSinceMs ?? null,
					medianScore: entry.medianScore ?? null,
					anchor: now,
				};
			}
		}
		peerCounts.set(counts);
		meshHealth.set(health);
	}) as () => void;
	api.subscribe('peers:count');
	// Re-subscribe on reconnect (backend has fresh subscribedEvents after reconnect)
	let skipFirst = true;
	unsubReconnect = connected.subscribe(isConnected => {
		if (skipFirst) {
			skipFirst = false;
			return;
		}
		if (isConnected && unsubListener) api.subscribe('peers:count');
	}) as () => void;
}

// Unsubscribe from peer count updates. Reference-counted: actual unsubscribe happens only when the last subscriber leaves.
export async function unsubscribePeerCounts(): Promise<void> {
	if (subscriberCount === 0) return;
	subscriberCount--;
	if (subscriberCount > 0) return;
	if (unsubReconnect) {
		unsubReconnect();
		unsubReconnect = null;
	}
	if (!unsubListener) return;
	await api.unsubscribe('peers:count');
	unsubListener();
	unsubListener = null;
	peerCounts.set({});
	meshHealth.set({});
}
