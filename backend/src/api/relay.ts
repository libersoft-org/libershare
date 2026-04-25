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
	let pollInterval: ReturnType<typeof setInterval> | null = null;
	// Previous poll snapshot for computing byte-rate deltas
	let prevDownloadBytes = 0;
	let prevUploadBytes = 0;
	let prevPollAt = Date.now();

	function countReservations(): number {
		// circuitRelayServer exposes reservations as a PeerMap on the service instance.
		// Client-side events 'relay:created-reservation' on the node track the *opposite* role
		// (when we reserve with a remote relay), so we read server state directly.
		const node = networks.getLibp2pNode();
		const relay = node?.services?.relay;
		const reservations = relay?.reservations;
		if (!reservations) return 0;
		return typeof reservations.size === 'number' ? reservations.size : 0;
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
		// simple-metrics tracks per-protocol stream bytes in a private `transferStats` Map
		// (keys like "/libp2p/circuit-relay/0.2.0/hop sent" and "... received").
		// The Map is not exposed via onMetrics, but we can read it directly from the metrics instance.
		const node = networks.getLibp2pNode();
		const stats: Map<string, number> | undefined = node?.metrics?.transferStats;
		if (!stats || typeof stats.get !== 'function') return { down: 0, up: 0 };
		let down = 0;
		let up = 0;
		for (const proto of [HOP_PROTOCOL, STOP_PROTOCOL]) {
			// "received" = bytes inbound on stream (remote peer → us); for a relay, traffic flowing
			// through us counts both sent+received on each side. We report them as up/down separately.
			down += stats.get(`${proto} received`) ?? 0;
			up += stats.get(`${proto} sent`) ?? 0;
		}
		return { down, up };
	}

	function getStats(): RelayStats {
		const now = Date.now();
		const { down, up } = readRelayBytes();
		const elapsedMs = now - prevPollAt;
		const downloadSpeed = elapsedMs > 0 ? Math.max(0, ((down - prevDownloadBytes) * 1000) / elapsedMs) : 0;
		const uploadSpeed = elapsedMs > 0 ? Math.max(0, ((up - prevUploadBytes) * 1000) / elapsedMs) : 0;
		prevDownloadBytes = down;
		prevUploadBytes = up;
		prevPollAt = now;
		return {
			reservations: countReservations(),
			activeTunnels: countActiveTunnels(),
			downloadSpeed,
			uploadSpeed,
		};
	}

	function startPolling(): void {
		if (pollInterval) return;
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
