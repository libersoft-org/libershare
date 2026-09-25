/**
 * How many relay reservations this node serves at once unless the operator chose otherwise.
 * A ceiling on concurrent reservations, not a bandwidth or data budget. 0 means unlimited.
 */
export const DEFAULT_MAX_RELAY_RESERVATIONS = 200;

/** True for a usable reservation limit: a non-negative safe integer, where 0 means unlimited. */
export function isRelayReservationLimit(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Read a reservation limit typed by the user. Only plain digits count, so an empty, negative,
 * fractional or otherwise malformed entry is null and can never turn into "unlimited".
 */
export function parseRelayReservationLimit(text: string): number | null {
	const trimmed = text.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const value = Number(trimmed);
	return isRelayReservationLimit(value) ? value : null;
}
