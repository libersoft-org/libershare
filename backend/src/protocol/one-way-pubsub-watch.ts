/**
 * How long a directly connected peer may receive our pubsub messages while sending none back
 * before the connection is renewed. Right after a (re)connect the streams take milliseconds to
 * pair up, so a minute only ever catches a pairing that is not going to happen.
 */
export const ONE_WAY_PUBSUB_GRACE_MS = 60_000;

/** What the router holds at one moment: peer IDs, as strings. */
export interface PubsubStreamSnapshot {
	/** Peers we hold an outbound pubsub stream to. */
	readonly outbound: Iterable<string>;
	/** Peers that hold one to us. */
	readonly inbound: Iterable<string>;
	/** Peers with at least one open connection that is neither relayed nor limited. */
	readonly direct: Iterable<string>;
}

/**
 * Finds peers whose pubsub has gone one-way.
 *
 * When a peer drops a connection and dials back within milliseconds, gossipsub on the two
 * sides can end up disagreeing: one keeps writing into an outbound stream the other never
 * reads. The writer sees no error, so nothing ever repairs it — measured at twelve minutes in
 * which the reader missed every subscription, `want` and search of that peer, and refused it
 * as a non-member of the network. The reader is the side that can tell: it holds an outbound
 * stream to the peer, so the peer speaks pubsub, yet has no inbound stream from it.
 */
export class OneWayPubsubWatch {
	private readonly missingSince = new Map<string, number>();

	/** Peers whose inbound stream has been missing for the whole grace period. Each is reported once per period. */
	check(snapshot: PubsubStreamSnapshot, now: number, graceMs: number = ONE_WAY_PUBSUB_GRACE_MS): string[] {
		const inbound = new Set(snapshot.inbound);
		const direct = new Set(snapshot.direct);
		const oneWay = new Set<string>();
		for (const peer of snapshot.outbound) if (direct.has(peer) && !inbound.has(peer)) oneWay.add(peer);
		for (const peer of this.missingSince.keys()) if (!oneWay.has(peer)) this.missingSince.delete(peer);
		const due: string[] = [];
		for (const peer of oneWay) {
			const since = this.missingSince.get(peer);
			if (since === undefined) this.missingSince.set(peer, now);
			else if (now - since >= graceMs) {
				due.push(peer);
				// Wait out another full period before reporting it again.
				this.missingSince.set(peer, now);
			}
		}
		return due;
	}

	clear(): void {
		this.missingSince.clear();
	}
}
