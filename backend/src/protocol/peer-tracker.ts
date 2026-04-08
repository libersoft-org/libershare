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
	connectedAt: number;
	lastActivity: number;
	stale: boolean;
}

interface PeerEntry {
	peerID: string;
	lishID: string;
	direction: 'download' | 'upload';
	connectionType: ConnectionType;
	connectedAt: number;
	speedSamples: { time: number; bytes: number }[];
	totalBytes: number;
	currentFile?: string;
	lastActivity: number;
	/** Exponential moving average of speed (bytes/s). Decays every emitter tick. */
	emaSpeed: number;
	lastEmaUpdate: number;
}

const SPEED_WINDOW = 10_000; // 10s rolling window
const STALE_THRESHOLD = 20_000; // 20s — peer shown dimmed
const PRUNE_THRESHOLD = 30_000; // 30s — peer removed entirely

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

// --- Public API: registration ---

export function registerDownloadPeer(lishID: string, peerID: string, connectionType: ConnectionType): void {
	const k = key(lishID, peerID, 'download');
	const existing = entries.get(k);
	if (existing) { existing.connectionType = connectionType; return; }
	entries.set(k, { peerID, lishID, direction: 'download', connectionType, connectedAt: Date.now(), speedSamples: [], totalBytes: cumulativeBytes.get(k) ?? 0, lastActivity: Date.now(), emaSpeed: 0, lastEmaUpdate: Date.now() });
	trace(`[PEERS] register download ${peerID.slice(0, 12)} for ${lishID.slice(0, 8)}`);
}

export function unregisterDownloadPeer(lishID: string, peerID: string): void {
	const k = key(lishID, peerID, 'download');
	const entry = entries.get(k);
	if (!entry) return;
	entry.speedSamples = [];
	trace(`[PEERS] unregister download ${peerID.slice(0, 12)} for ${lishID.slice(0, 8)}`);
}

export function registerUploadPeer(lishID: string, peerID: string, connectionType: ConnectionType): void {
	const k = key(lishID, peerID, 'upload');
	const existing = entries.get(k);
	if (existing) { existing.connectionType = connectionType; return; }
	entries.set(k, { peerID, lishID, direction: 'upload', connectionType, connectedAt: Date.now(), speedSamples: [], totalBytes: cumulativeBytes.get(k) ?? 0, lastActivity: Date.now(), emaSpeed: 0, lastEmaUpdate: Date.now() });
	trace(`[PEERS] register upload ${peerID.slice(0, 12)} for ${lishID.slice(0, 8)}`);
}

export function unregisterUploadPeer(lishID: string, peerID: string): void {
	const k = key(lishID, peerID, 'upload');
	const entry = entries.get(k);
	if (!entry) return;
	entry.speedSamples = [];
	trace(`[PEERS] unregister upload ${peerID.slice(0, 12)} for ${lishID.slice(0, 8)}`);
}

export function unregisterAllPeersForLISH(lishID: string): void {
	for (const [, entry] of entries) {
		if (entry.lishID === lishID) entry.speedSamples = [];
	}
}

// --- Public API: recording bytes ---

/** Keep peer alive during throttle waits (prevents stale/prune while peer is throttled). */
export function touchPeer(lishID: string, peerID: string, direction: 'download' | 'upload'): void {
	const k = key(lishID, peerID, direction);
	const entry = entries.get(k);
	if (entry) entry.lastActivity = Date.now();
}

export function recordDownloadBytes(lishID: string, peerID: string, bytes: number, currentFile?: string): void {
	const k = key(lishID, peerID, 'download');
	const entry = entries.get(k);
	if (!entry) return;
	const now = Date.now();
	entry.speedSamples.push({ time: now, bytes });
	entry.totalBytes += bytes;
	cumulativeBytes.set(k, entry.totalBytes);
	entry.lastActivity = now;
	// EMA: instantaneous speed from this chunk, blended with history
	const dt = Math.max((now - entry.lastEmaUpdate) / 1000, 0.1);
	const instantSpeed = bytes / dt;
	const alpha = Math.min(0.5, dt / 3); // adapt smoothing to time gap
	entry.emaSpeed = entry.emaSpeed * (1 - alpha) + instantSpeed * alpha;
	entry.lastEmaUpdate = now;
	if (currentFile !== undefined) entry.currentFile = currentFile;
}

export function recordUploadBytes(lishID: string, peerID: string, bytes: number): void {
	const k = key(lishID, peerID, 'upload');
	const entry = entries.get(k);
	if (!entry) return;
	const now = Date.now();
	entry.speedSamples.push({ time: now, bytes });
	entry.totalBytes += bytes;
	cumulativeBytes.set(k, entry.totalBytes);
	entry.lastActivity = now;
	const dt = Math.max((now - entry.lastEmaUpdate) / 1000, 0.1);
	const instantSpeed = bytes / dt;
	const alpha = Math.min(0.5, dt / 3);
	entry.emaSpeed = entry.emaSpeed * (1 - alpha) + instantSpeed * alpha;
	entry.lastEmaUpdate = now;
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

	// Prune old entries and their cumulative bytes
	for (const [k, entry] of entries) {
		if (now - entry.lastActivity > PRUNE_THRESHOLD) { entries.delete(k); cumulativeBytes.delete(k); }
		else entry.speedSamples = entry.speedSamples.filter(s => s.time > now - SPEED_WINDOW);
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

		// Decay EMA towards zero when no data arrives (1s tick)
		const dt = (now - entry.lastEmaUpdate) / 1000;
		if (dt > 0.5) {
			const decay = Math.exp(-dt / 3); // 3s half-life
			entry.emaSpeed *= decay;
			entry.lastEmaUpdate = now;
		}
		const speed = Math.round(entry.emaSpeed);
		const isStale = now - entry.lastActivity > STALE_THRESHOLD;

		const existing = peerMap.get(entry.peerID);
		if (existing) {
			if (entry.direction === 'download') {
				existing.downloadSpeed = speed;
				existing.totalDownloaded = entry.totalBytes;
				if (entry.currentFile) existing.currentFile = entry.currentFile;
			} else {
				existing.uploadSpeed = speed;
				existing.totalUploaded = entry.totalBytes;
			}
			existing.stale = existing.stale && isStale;
			if (entry.connectedAt < existing.connectedAt) existing.connectedAt = entry.connectedAt;
			if (entry.lastActivity > existing.lastActivity) existing.lastActivity = entry.lastActivity;
		} else {
			peerMap.set(entry.peerID, {
				peerID: entry.peerID.slice(0, 12),
				connectionType: entry.connectionType,
				downloadSpeed: entry.direction === 'download' ? speed : 0,
				uploadSpeed: entry.direction === 'upload' ? speed : 0,
				totalDownloaded: entry.direction === 'download' ? entry.totalBytes : 0,
				totalUploaded: entry.direction === 'upload' ? entry.totalBytes : 0,
				currentFile: entry.currentFile,
				connectedAt: entry.connectedAt,
				lastActivity: entry.lastActivity,
				stale: isStale,
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
