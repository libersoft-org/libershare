/**
 * What a lishnet write did, as the backend reports it when asked with `detailed: true`.
 *
 * - `stored`: this request was accepted and its desired state was saved. A duplicate add, or an
 *   update/delete of a network that does not exist, is `stored: false`.
 * - `applied`: when the request finished, the running node really was in the state this request
 *   asked for — membership and installed bootstrap list. A later request that overwrote it makes
 *   this `false`, even when the node reached that newer state.
 * - `transitioned`: this request is the one that changed the network's membership (joined or left).
 * - `value`: what the plain, non-detailed call returns.
 */
export interface NetworkMutationOutcome<T> {
	stored: boolean;
	applied: boolean;
	transitioned: boolean;
	value: T;
	/** For a single network: whether it is joined now. */
	joined?: boolean;
	/** For a batch: one outcome per network it touched. */
	items?: Array<NetworkMutationOutcome<null> & { networkID: string }>;
}

/**
 * The answer of a server that predates detailed outcomes: only the plain value. It says the
 * request was accepted, never that the running node applied it.
 */
export interface LegacyNetworkMutation<T> {
	legacy: true;
	value: T;
}

export type NetworkMutationResponse<T> = NetworkMutationOutcome<T> | LegacyNetworkMutation<T>;

/** Combine per-network outcomes: applied only when every one was, transitioned when any was. */
export function combineNetworkMutations<T>(value: T, items: Array<NetworkMutationOutcome<null> & { networkID: string }>): NetworkMutationOutcome<T> {
	return { stored: true, applied: items.every(item => item.applied), transitioned: items.some(item => item.transitioned), value, items };
}

/** Read a detailed response, or wrap an older server's plain answer without inventing `applied`. */
export function toNetworkMutationResponse<T>(response: unknown): NetworkMutationResponse<T> {
	if (response !== null && typeof response === 'object' && 'stored' in response && 'applied' in response && 'value' in response) return response as NetworkMutationOutcome<T>;
	return { legacy: true, value: response as T };
}
