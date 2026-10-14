/**
 * How long a connection may deliver no bytes at all before it is treated as dead.
 *
 * A live connection hears from the far side every few seconds even when idle: the far side's
 * connection monitor pings it every 10 s, the far side answers ours, and yamux keep-alive adds
 * one more every 30 s. Under a bulk transfer data arrives continuously. So 45 s of silence is
 * several missed heartbeats in a row — a path that drops packets without closing (a NAT mapping
 * gone, a link pulled) — whereas one delayed or reset ping, which aborting on ping failure used
 * to punish, never comes close.
 */
export const CONNECTION_SILENCE_LIMIT_MS = 45_000;

const SWEEP_INTERVAL_MS = 5_000;

/** The part of a libp2p MultiaddrConnection this watch uses. */
export interface WatchedConnection {
	readonly status: string;
	readonly remoteAddr: { toString(): string };
	dispatchEvent(event: Event): boolean;
	addEventListener(type: 'close', listener: () => void, options?: { once?: boolean }): void;
	abort(err: Error): void;
}

/**
 * Closes connections that have gone silent.
 *
 * Without it a connection whose packets are silently dropped stays open until the kernel gives up
 * retransmitting — measured at 16 minutes on Linux — and every new stream to that peer is opened on
 * it, because libp2p reuses an open connection. Inbound bytes are observed the way
 * `@libp2p/simple-metrics` counts them: by wrapping `dispatchEvent`, so no `message` listener is
 * added and no inbound data is consumed early. Silence is timed on `performance.now()`, which a
 * change of the system clock does not move.
 */
export class ConnectionLiveness {
	private readonly lastHeard = new Map<WatchedConnection, number>();
	private timer: ReturnType<typeof setInterval> | undefined;

	/** Start watching a connection; called for every connection libp2p upgrades. */
	track(conn: WatchedConnection, now: number = performance.now()): void {
		this.lastHeard.set(conn, now);
		const dispatch = conn.dispatchEvent.bind(conn);
		conn.dispatchEvent = (event: Event): boolean => {
			if (event.type === 'message' && this.lastHeard.has(conn)) this.lastHeard.set(conn, performance.now());
			return dispatch(event);
		};
		conn.addEventListener('close', () => this.lastHeard.delete(conn), { once: true });
	}

	/** Abort every open connection silent for longer than the limit. Returns how many were aborted. */
	sweep(now: number = performance.now(), limitMs: number = CONNECTION_SILENCE_LIMIT_MS): number {
		let aborted = 0;
		for (const [conn, heard] of this.lastHeard) {
			if (conn.status !== 'open') {
				this.lastHeard.delete(conn);
				continue;
			}
			if (now - heard < limitMs) continue;
			this.lastHeard.delete(conn);
			console.log(`[NET] nothing received from ${conn.remoteAddr.toString()} for ${Math.round((now - heard) / 1000)}s, closing the connection`);
			conn.abort(new Error(`connection silent for ${Math.round((now - heard) / 1000)} s`));
			aborted++;
		}
		return aborted;
	}

	/** Start the periodic sweep. Keeps connections tracked before it, e.g. while the node was starting. */
	start(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
	}

	/** Stop sweeping and forget every connection; the node they belong to is being torn down. */
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.lastHeard.clear();
	}
}

type MetricsFactory = (components: any) => { trackMultiaddrConnection(maConn: any): void };

/** Wrap a libp2p metrics factory so every connection the upgrader reports to it is also watched for silence. */
export function withConnectionLiveness<F extends MetricsFactory>(factory: F, liveness: ConnectionLiveness | undefined): F {
	if (!liveness) return factory;
	return ((components: any) => {
		const metrics = factory(components);
		const track = metrics.trackMultiaddrConnection.bind(metrics);
		metrics.trackMultiaddrConnection = (maConn: any): void => {
			liveness.track(maConn);
			track(maConn);
		};
		return metrics;
	}) as F;
}
