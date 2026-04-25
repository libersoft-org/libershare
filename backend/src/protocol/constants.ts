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
 * fail-closed fallback whenever a user-supplied threshold is missing, non-finite, or <= 0.
 */
export const DEFAULT_ACCEPT_PX_THRESHOLD = 5;

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

/**
 * Parse a user-supplied acceptPXThreshold. Returns the effective threshold and whether the
 * raw value was unsafe (non-finite, non-number, or <= 0). The effective threshold is always
 * a safe positive number; callers may warn on `unsafe === true`.
 */
export function parseAcceptPXThreshold(raw: unknown): { value: number; unsafe: boolean; raw: unknown } {
	const isValid = typeof raw === 'number' && Number.isFinite(raw);
	const candidate = isValid ? (raw as number) : DEFAULT_ACCEPT_PX_THRESHOLD;
	const unsafe = !isValid || candidate <= 0;
	return { value: unsafe ? DEFAULT_ACCEPT_PX_THRESHOLD : candidate, unsafe, raw };
}
