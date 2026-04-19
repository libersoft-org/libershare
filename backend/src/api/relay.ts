import type { RelayStats } from '@shared';
import type { Networks } from '../lishnet/lishnets.ts';

type BroadcastFn = (event: string, data: any) => void;
type HasSubscribersFn = (event: string) => boolean;

const POLL_INTERVAL_MS = 1000;
const HOP_PROTOCOL = '/libp2p/circuit-relay/0.2.0/hop';
const STOP_PROTOCOL = '/libp2p/circuit-relay/0.2.0/stop';

interface RelayHandlers {
	stats: () => RelayStats;
	startPolling: () => void;
	stopPolling: () => void;
}

export function initRelayHandlers(networks: Networks, broadcast: BroadcastFn, hasSubscribers: HasSubscribersFn): RelayHandlers {
	// Active reservations: peerIDs of clients that reserved a relay slot with us
	const reservations = new Set<string>();
	let listenersAttached = false;
	let pollInterval: ReturnType<typeof setInterval> | null = null;

	// Previous poll snapshot for computing byte-rate deltas (reserved for future libp2p metrics integration)
	let prevDownloadBytes = 0;
	let prevUploadBytes = 0;
	let prevPollAt = Date.now();

	function attachListeners(): void {
		if (listenersAttached) return;
		const node = networks.getLibp2pNode();
		if (!node) return;
		listenersAttached = true;
		// libp2p emits these events when we ARE the relay server and peers reserve a slot
		node.addEventListener?.('relay:created-reservation', (evt: any) => {
			const peerID = evt?.detail?.relay?.toString?.() ?? evt?.detail?.remotePeer?.toString?.();
			if (peerID) reservations.add(peerID);
		});
		node.addEventListener?.('relay:removed', (evt: any) => {
			const peerID = evt?.detail?.relay?.toString?.() ?? evt?.detail?.remotePeer?.toString?.();
			if (peerID) reservations.delete(peerID);
		});
	}

	function countActiveTunnels(): number {
		// Count active HOP streams across all connections — each indicates a peer currently relaying data through us
		const node = networks.getLibp2pNode();
		if (!node) return 0;
		let count = 0;
		try {
			const connections = node.getConnections?.() ?? [];
			for (const conn of connections) {
				const streams = conn.streams ?? [];
				for (const s of streams) {
					const proto = s.protocol ?? '';
					if (proto === HOP_PROTOCOL || proto === STOP_PROTOCOL) count++;
				}
			}
		} catch {}
		return count;
	}

	function readRelayBytes(): { down: number; up: number } {
		// Read latest metrics snapshot from simpleMetrics() callback (set up in network-config.ts).
		// libp2p records per-protocol stream bytes via Metrics.trackProtocolStream. simple-metrics
		// exposes them as counter groups; exact key shape differs by metric name, so we walk the
		// snapshot defensively and sum any counter whose key references the hop/stop protocol.
		const snapshot: Record<string, any> = (globalThis as any).__libp2pMetricsSnapshot?.current ?? {};
		let down = 0;
		let up = 0;
		function walk(obj: any, path: string): void {
			if (obj == null) return;
			if (typeof obj === 'number') {
				const p = path.toLowerCase();
				const isRelay = p.includes('circuit-relay') || p.includes('circuit_relay') || p.includes(HOP_PROTOCOL) || p.includes(STOP_PROTOCOL);
				if (!isRelay) return;
				const isBytes = p.includes('bytes') || p.includes('byte_total');
				if (!isBytes) return;
				if (p.includes('recv') || p.includes('in') || p.includes('download')) down += obj;
				else if (p.includes('send') || p.includes('out') || p.includes('upload')) up += obj;
				return;
			}
			if (typeof obj === 'object') {
				for (const k of Object.keys(obj)) walk(obj[k], path + '.' + k);
			}
		}
		walk(snapshot, '');
		return { down, up };
	}

	function getStats(): RelayStats {
		attachListeners();
		const now = Date.now();
		const { down, up } = readRelayBytes();
		const elapsedMs = now - prevPollAt;
		const downloadSpeed = elapsedMs > 0 ? Math.max(0, ((down - prevDownloadBytes) * 1000) / elapsedMs) : 0;
		const uploadSpeed = elapsedMs > 0 ? Math.max(0, ((up - prevUploadBytes) * 1000) / elapsedMs) : 0;
		prevDownloadBytes = down;
		prevUploadBytes = up;
		prevPollAt = now;
		return {
			reservations: reservations.size,
			activeTunnels: countActiveTunnels(),
			downloadSpeed,
			uploadSpeed,
		};
	}

	function startPolling(): void {
		if (pollInterval) return;
		attachListeners();
		pollInterval = setInterval(() => {
			if (hasSubscribers('relay:stats')) broadcast('relay:stats', getStats());
		}, POLL_INTERVAL_MS);
	}

	function stopPolling(): void {
		if (pollInterval) {
			clearInterval(pollInterval);
			pollInterval = null;
		}
	}

	return { stats: getStats, startPolling, stopPolling };
}
