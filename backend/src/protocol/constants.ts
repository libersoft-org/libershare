/**
 * Protocol-level constants shared across protocol modules.
 */

/**
 * Pubsub topic namespace for lishnet network IDs.
 * All lishnet pubsub topics use this prefix; used by PX ingress filter and peer-count checks.
 */
export const LISH_TOPIC_PREFIX = 'lish/';

/**
 * Default gossipsub acceptPXThreshold. Matches the default in settings.ts and is used as
 * fail-closed fallback whenever a user-supplied threshold is missing, non-finite, or <= 1.
 */
export const DEFAULT_ACCEPT_PX_THRESHOLD = 5;

/**
 * Longest `searchID` we accept on the pubsub search path.
 *
 * The ID is echoed into the response and kept in the dedup map for the whole dedup
 * window, so its length is attacker-controlled memory held on our side. Our own IDs are
 * `randomUUID()` (36 chars); the slack covers a peer using some other unique-ID scheme.
 * Without a bound a single peer can park hundreds of kilobytes per query — deduplication
 * cannot stop it, since a fresh ID per request is what makes the entries unique.
 */
export const MAX_SEARCH_ID_LENGTH = 64;

/**
 * Longest search query we accept, on EVERY path that takes one.
 *
 * A query is lowercased once and then substring-matched against the id and the name of
 * every advertised LISH, so its length is multiplied by the size of the catalog. The
 * bound lived only on the pubsub path, which left the unicast `getLishs` request free to
 * carry a string up to the whole protocol frame limit for the same work. The UI never
 * sends anything remotely this long.
 */
export const MAX_SEARCH_QUERY_LENGTH = 256;

/**
 * Returns the pubsub topic name for a given lishnet/network ID.
 */
export function lishTopic(networkID: string): string {
	return `${LISH_TOPIC_PREFIX}${networkID}`;
}

/**
 * Normalise a user-supplied list of trusted PX peer IDs into a deduplicated Set.
 * Non-string entries and empty strings are discarded, surrounding whitespace is trimmed.
 * Centralised so the libp2p config builder and the ingress filter cannot drift apart.
 */
export function normalizeTrustedPeerIds(raw: unknown): Set<string> {
	if (!Array.isArray(raw)) return new Set();
	return new Set(
		raw
			.filter((p): p is string => typeof p === 'string')
			.map(p => p.trim())
			.filter(Boolean)
	);
}

/** Result of parsing a user-supplied acceptPXThreshold: the effective value, whether the raw input was unsafe, and the raw input echoed back. */
export interface IAcceptPXThreshold {
	value: number;
	unsafe: boolean;
	raw: unknown;
}

/**
 * Parse a user-supplied acceptPXThreshold. Returns the effective threshold and whether the
 * raw value was unsafe (non-finite, non-number, or <= 1). The effective threshold is always
 * a safe positive number; callers may warn on `unsafe === true`.
 */
export function parseAcceptPXThreshold(raw: unknown): IAcceptPXThreshold {
	const isValid = typeof raw === 'number' && Number.isFinite(raw);
	const candidate = isValid ? (raw as number) : DEFAULT_ACCEPT_PX_THRESHOLD;
	const unsafe = !isValid || candidate <= 1;
	return { value: unsafe ? DEFAULT_ACCEPT_PX_THRESHOLD : candidate, unsafe, raw };
}
