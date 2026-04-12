import { trace } from '../logger.ts';

export type ConnectionType = 'DIRECT' | 'RELAY' | 'DCUtR';

export interface PeerDetail {
	peerID: string;
	connectionType: ConnectionType;
	downloadSpeed: number;
	uploadSpeed: number;
	totalDownloaded: number;
	totalUploaded: number;
	currentFile?: string;
	currentChunk?: string;
	connectedAt: number;
	lastActivity: number;
	stale: boolean;
	havePercent?: number;
}

interface SpeedSample {
	time: number;
	bytes: number;
}

const SPEED_WINDOW = 30_000; // 30s — per-peer chunk interval is 5-18s, need ≥2 samples in window

interface PeerEntry {
	peerID: string;
	lishID: string;
	direction: 'download' | 'upload';
	connectionType: ConnectionType;
	connectedAt: number;
	totalBytes: number;
	currentFile?: string;
	currentChunk?: string;
	lastActivity: number;
	/** Per-peer sliding window speed samples (same algorithm as global). */
	speedSamples: SpeedSample[];
	/** Percentage of LISH chunks this peer has (from have message). */
	havePercent?: number;
}

const STALE_THRESHOLD = 30_000; // 30s — peer shown dimmed
const PRUNE_THRESHOLD = 60_000; // 60s — peer removed entirely

// Per-peer per-direction entries
const entries = new Map<string, PeerEntry>();
// Cumulative bytes per key — survives prune/unregister cycles
const cumulativeBytes = new Map<string, number>();

// Subscription management: which clients want peers for which lishIDs
type ClientRef = any;
const subscriptions = new Map<ClientRef, Set<string>>();

// Broadcast function (set by transfer.ts)
type EmitFn = (client: ClientRef, event: string, data: any) => void;
let emitFn: EmitFn | null = null;
let emitInterval: ReturnType<typeof setInterval> | null = null;

function key(lishID: string, peerID: string, direction: 'download' | 'upload'): string {
	return `${lishID}:${peerID}:${direction}`;
}

function createEntry(peerID: string, lishID: string, direction: 'download' | 'upload', connectionType: ConnectionType, havePercent?: number): PeerEntry {
	const k = key(lishID, peerID, direction);
	const now = Date.now();
	return { peerID, lishID, direction, connectionType, connectedAt: now, totalBytes: cumulativeBytes.get(k) ?? 0, lastActivity: now, speedSamples: [], havePercent };
}

/**
 * Compute speed from sliding window using actual elapsed time (not fixed denominator).
 * Avoids chunk-size quantization: divides by time since oldest sample, not fixed window.
 * For N chunks in T seconds: speed = N*chunkSize / T (accurate, not staircase).
 */
function computeSpeed(samples: SpeedSample[], now: number): number {
	if (samples.length === 0) return 0;
	const cutoff = now - SPEED_WINDOW;
	let total = 0;
	let oldestTime = now;
	let count = 0;
	for (let i = samples.length - 1; i >= 0; i--) {
		if (samples[i]!.time <= cutoff) break;
		total += samples[i]!.bytes;
		oldestTime = samples[i]!.time;
		count++;
	}
	if (count === 0 || total === 0) return 0;
	// For single sample: use time from sample to now as denominator
	const elapsed = count === 1 ? (now - oldestTime) / 1000 : (now - oldestTime) / 1000;
	if (elapsed < 0.5) return 0;
	return Math.round(total / elapsed);
}

/** Prune expired samples from the window. */
function pruneSamples(samples: SpeedSample[], now: number): void {
	const cutoff = now - SPEED_WINDOW;
	let i = 0;
	while (i < samples.length && samples[i]!.time <= cutoff) i++;
	if (i > 0) samples.splice(0, i);
}

// --- Public API: registration ---

export function registerDownloadPeer(lishID: string, peerID: string, connectionType: ConnectionType, havePercent?: number): void {
	const k = key(lishID, peerID, 'download');
	const existing = entries.get(k);
	if (existing) { existing.connectionType = connectionType; if (havePercent !== undefined) existing.havePercent = havePercent; return; }
	entries.set(k, createEntry(peerID, lishID, 'download', connectionType, havePercent));
	trace(`[PEERS] register download ${peerID.slice(0, 12)} for ${lishID.slice(0, 8)}`);
}

export function unregisterDownloadPeer(lishID: string, peerID: string): void {
	const k = key(lishID, peerID, 'download');
	if (!entries.has(k)) return;
	entries.delete(k);
	trace(`[PEERS] unregister download ${peerID.slice(0, 12)} for ${lishID.slice(0, 8)}`);
}

export function registerUploadPeer(lishID: string, peerID: string, connectionType: ConnectionType): void {
	const k = key(lishID, peerID, 'upload');
	const existing = entries.get(k);
	if (existing) { existing.connectionType = connectionType; return; }
	entries.set(k, createEntry(peerID, lishID, 'upload', connectionType));
	trace(`[PEERS] register upload ${peerID.slice(0, 12)} for ${lishID.slice(0, 8)}`);
}

export function unregisterUploadPeer(lishID: string, peerID: string): void {
	const k = key(lishID, peerID, 'upload');
	if (!entries.has(k)) return;
	entries.delete(k);
	trace(`[PEERS] unregister upload ${peerID.slice(0, 12)} for ${lishID.slice(0, 8)}`);
}

export function unregisterAllPeersForLISH(lishID: string): void {
	for (const [k, entry] of entries) {
		if (entry.lishID === lishID) entries.delete(k);
	}
	// Clear cumulative bytes for this LISH — prevents leak and wrong totals if LISH is re-added
	for (const k of cumulativeBytes.keys()) {
		if (k.startsWith(`${lishID}:`)) cumulativeBytes.delete(k);
	}
}

// --- Public API: recording bytes ---

export function updatePeerHavePercent(lishID: string, peerID: string, havePercent: number): void {
	const k = key(lishID, peerID, 'download');
	const entry = entries.get(k);
	if (entry) entry.havePercent = havePercent;
}

export function touchPeer(lishID: string, peerID: string, direction: 'download' | 'upload'): void {
	const k = key(lishID, peerID, direction);
	const entry = entries.get(k);
	if (entry) entry.lastActivity = Date.now();
}

export function recordDownloadBytes(lishID: string, peerID: string, bytes: number, currentFile?: string, currentChunk?: string): void {
	const k = key(lishID, peerID, 'download');
	let entry = entries.get(k);
	if (!entry) {
		// Re-register if pruned while peer was throttled
		entries.set(k, createEntry(peerID, lishID, 'download', 'DIRECT'));
		entry = entries.get(k)!;
	}
	const now = Date.now();
	entry.totalBytes += bytes;
	cumulativeBytes.set(k, entry.totalBytes);
	entry.lastActivity = now;
	entry.speedSamples.push({ time: now, bytes });
	if (currentFile !== undefined) entry.currentFile = currentFile;
	if (currentChunk !== undefined) entry.currentChunk = currentChunk;
}

export function recordUploadBytes(lishID: string, peerID: string, bytes: number, currentChunk?: string, currentFile?: string): void {
	const k = key(lishID, peerID, 'upload');
	let entry = entries.get(k);
	if (!entry) {
		entries.set(k, createEntry(peerID, lishID, 'upload', 'DIRECT'));
		entry = entries.get(k)!;
	}
	const now = Date.now();
	entry.totalBytes += bytes;
	cumulativeBytes.set(k, entry.totalBytes);
	entry.lastActivity = now;
	entry.speedSamples.push({ time: now, bytes });
	if (currentChunk !== undefined) entry.currentChunk = currentChunk;
	if (currentFile !== undefined) entry.currentFile = currentFile;
}

// --- Public API: subscription management ---

export function subscribePeers(client: ClientRef, lishID: string): void {
	if (!subscriptions.has(client)) subscriptions.set(client, new Set());
	subscriptions.get(client)!.add(lishID);
	trace(`[PEERS] client subscribed to ${lishID.slice(0, 8)}`);
}

export function unsubscribePeers(client: ClientRef, lishID: string): void {
	subscriptions.get(client)?.delete(lishID);
	if (subscriptions.get(client)?.size === 0) subscriptions.delete(client);
	trace(`[PEERS] client unsubscribed from ${lishID.slice(0, 8)}`);
}

export function unsubscribeAllPeers(client: ClientRef): void {
	subscriptions.delete(client);
}

// --- Debug API: snapshot of internal state ---

export interface PeerTrackerDebugEntry {
	key: string;
	peerID: string;
	lishID: string;
	direction: 'download' | 'upload';
	connectionType: ConnectionType;
	connectedAt: number;
	lastActivity: number;
	totalBytes: number;
	cumulativeBytes: number;
	sampleCount: number;
	sampleWindowMs: number;
	sampleBytesSum: number;
	computedSpeed: number;
	ageSinceLastActivityMs: number;
}

export function getDebugSnapshot(lishID?: string): { now: number; entries: PeerTrackerDebugEntry[]; cumulativeKeys: string[] } {
	const now = Date.now();
	const out: PeerTrackerDebugEntry[] = [];
	for (const [k, entry] of entries) {
		if (lishID && entry.lishID !== lishID) continue;
		const sampleBytesSum = entry.speedSamples.reduce((s, x) => s + x.bytes, 0);
		const windowMs = entry.speedSamples.length >= 2 ? (entry.speedSamples[entry.speedSamples.length - 1]!.time - entry.speedSamples[0]!.time) : 0;
		const computedSpeed = computeSpeed(entry.speedSamples, now);
		out.push({
			key: k,
			peerID: entry.peerID,
			lishID: entry.lishID,
			direction: entry.direction,
			connectionType: entry.connectionType,
			connectedAt: entry.connectedAt,
			lastActivity: entry.lastActivity,
			totalBytes: entry.totalBytes,
			cumulativeBytes: cumulativeBytes.get(k) ?? 0,
			sampleCount: entry.speedSamples.length,
			sampleWindowMs: windowMs,
			sampleBytesSum,
			computedSpeed,
			ageSinceLastActivityMs: now - entry.lastActivity,
		});
	}
	return { now, entries: out, cumulativeKeys: Array.from(cumulativeBytes.keys()).filter(k => !lishID || k.startsWith(`${lishID}:`)) };
}

// --- Emitter setup ---

export function setPeerEmit(fn: EmitFn): void {
	emitFn = fn;
}

export function startPeerEmitter(): void {
	if (emitInterval) return;
	emitInterval = setInterval(emitPeerDetails, 1000);
}

export function stopPeerEmitter(): void {
	if (emitInterval) { clearInterval(emitInterval); emitInterval = null; }
}

// --- Internal: emit aggregated peer details ---

function emitPeerDetails(): void {
	if (!emitFn) return;

	const now = Date.now();

	// Prune old entries (cumulative bytes survive for future re-registration)
	for (const [k, entry] of entries) {
		if (now - entry.lastActivity > PRUNE_THRESHOLD) entries.delete(k);
	}

	// Collect subscribed lishIDs across all clients
	const subscribedLishIDs = new Set<string>();
	for (const [, lishIDs] of subscriptions) {
		for (const id of lishIDs) subscribedLishIDs.add(id);
	}
	if (subscribedLishIDs.size === 0) return;

	// Group entries by lishID, then merge download+upload per peerID
	const byLish = new Map<string, Map<string, PeerDetail>>();

	for (const entry of entries.values()) {
		if (!subscribedLishIDs.has(entry.lishID)) continue;

		if (!byLish.has(entry.lishID)) byLish.set(entry.lishID, new Map());
		const peerMap = byLish.get(entry.lishID)!;

		// Prune expired samples and compute speed from sliding window
		pruneSamples(entry.speedSamples, now);
		const speed = computeSpeed(entry.speedSamples, now);
		const isStale = now - entry.lastActivity > STALE_THRESHOLD;

		const existing = peerMap.get(entry.peerID);
		if (existing) {
			if (entry.direction === 'download') {
				existing.downloadSpeed = speed;
				existing.totalDownloaded = entry.totalBytes;
				if (entry.currentFile) existing.currentFile = entry.currentFile;
				if (entry.currentChunk) existing.currentChunk = entry.currentChunk;
			} else {
				existing.uploadSpeed = speed;
				existing.totalUploaded = entry.totalBytes;
				if (entry.currentChunk) existing.currentChunk = entry.currentChunk;
			}
			if (entry.havePercent !== undefined) existing.havePercent = entry.havePercent;
			// Prefer DCUtR > RELAY > DIRECT for display
			if (entry.connectionType === 'DCUtR' || (entry.connectionType === 'RELAY' && existing.connectionType === 'DIRECT')) {
				existing.connectionType = entry.connectionType;
			}
			existing.stale = existing.stale && isStale;
			if (entry.connectedAt < existing.connectedAt) existing.connectedAt = entry.connectedAt;
			if (entry.lastActivity > existing.lastActivity) existing.lastActivity = entry.lastActivity;
		} else {
			peerMap.set(entry.peerID, {
				peerID: entry.peerID,
				connectionType: entry.connectionType,
				downloadSpeed: entry.direction === 'download' ? speed : 0,
				uploadSpeed: entry.direction === 'upload' ? speed : 0,
				totalDownloaded: entry.direction === 'download' ? entry.totalBytes : 0,
				totalUploaded: entry.direction === 'upload' ? entry.totalBytes : 0,
				currentFile: entry.currentFile,
				currentChunk: entry.currentChunk,
				connectedAt: entry.connectedAt,
				lastActivity: entry.lastActivity,
				stale: isStale,
				havePercent: entry.havePercent,
			});
		}
	}

	// Emit to subscribed clients
	for (const [client, lishIDs] of subscriptions) {
		for (const lishID of lishIDs) {
			const peerMap = byLish.get(lishID);
			const peers = peerMap ? Array.from(peerMap.values()) : [];
			emitFn(client, 'transfer.peers', { lishID, peers });
		}
	}
}
