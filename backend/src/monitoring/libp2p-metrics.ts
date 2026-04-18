// Libp2p metrics bridge — receives snapshots from @libp2p/simple-metrics
// and exposes them as a memory-trace source. Stored snapshot is the raw
// Record<string,any> from libp2p; the mem-trace picks out the handful of
// counters useful for leak correlation.

import { registerMemTraceSource } from './memory-trace.ts';

let latest: Record<string, any> = {};

/** Hook wired into simpleMetrics({ onMetrics }). */
export function onLibp2pMetrics(metrics: Record<string, any>): void {
	latest = metrics;
}

/** Keys we care about for periodic trace. Rest of `latest` is discarded at sample time. */
const TRACKED_KEYS = [
	'libp2p_peer_store_peers_total',
	'libp2p_connection_manager_connections',
	'libp2p_dialer_pending_dials',
	'libp2p_dial_queue_length',
	'libp2p_transport_circuit_relay_reservations',
	'gossipsub_peers_total',
	'gossipsub_mesh_peers_total',
	'gossipsub_mcache_size',
];

registerMemTraceSource('libp2p', () => {
	const out: Record<string, unknown> = {};
	for (const key of TRACKED_KEYS) {
		if (key in latest) out[key] = latest[key];
	}
	return out;
});
