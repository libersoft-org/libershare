/**
 * The relay reservation limit as the settings screen handles it. 0 means unlimited, so an
 * empty, negative or malformed entry must neither become 0 nor be sent at all — the old
 * `parseInt(...) || 100` sent 100 for an empty field and `Math.max(0, -5)` turned a negative
 * number into an unlimited relay.
 */
import { expect, test } from 'bun:test';
import { get } from 'svelte/store';
import { DEFAULT_MAX_RELAY_RESERVATIONS, parseRelayReservationLimit } from '@shared';
import { maxRelayReservations, setMaxRelayReservations } from '../../src/scripts/settings.ts';

test('only plain non-negative integers are read as a limit', () => {
	expect(parseRelayReservationLimit('0')).toBe(0);
	expect(parseRelayReservationLimit(' 250 ')).toBe(250);
	for (const text of ['', ' ', '-5', '1.5', '1e3', 'abc', '0x10', '99999999999999999999']) expect(parseRelayReservationLimit(text)).toBeNull();
});

test('new installations start with the finite default', () => {
	expect(DEFAULT_MAX_RELAY_RESERVATIONS).toBe(200);
	expect(get(maxRelayReservations)).toBe(DEFAULT_MAX_RELAY_RESERVATIONS);
});

test('an invalid value never reaches the store, an explicit 0 does', () => {
	for (const value of [-5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		setMaxRelayReservations(value);
		expect(get(maxRelayReservations)).toBe(DEFAULT_MAX_RELAY_RESERVATIONS);
	}
	setMaxRelayReservations(0);
	expect(get(maxRelayReservations)).toBe(0);
});
